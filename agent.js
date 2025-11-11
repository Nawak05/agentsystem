const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const decompress = require("decompress");
const decompressTarxz = require("decompress-tarxz");
const { execSync } = require("child_process");

const BACKEND_URL = "https://universellhub-hosting.shop";
const AGENT_TOKEN = "TEST_AGENT_001"; // Doit correspondre à celui dans ta BDD

// === Connexion Socket.IO ===
const socket = io(BACKEND_URL, {
    path: "/agents",
    transports: ["websocket"],
});

socket.on("connect", () => {
    console.log("🔌 Connecté au backend !");
    socket.emit("auth", { token: AGENT_TOKEN });
});

socket.on("auth_ok", () => console.log("✅ Auth OK"));
socket.on("auth_error", (e) => console.log("❌ Auth échouée :", e.message));
socket.on("disconnect", () => console.log("❌ Déconnecté"));

// === Création dossier serveur ===
async function createServerFolder(serverId, gameType, version) {
    const basePath = path.join(__dirname, "servers");
    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath);

    const serverPath = path.join(basePath, `server_${serverId}`);
    if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath);

    const configFile = path.join(serverPath, "config.json");
    const defaultConfig = {
        game_type: gameType,
        version,
        created_at: new Date().toISOString(),
    };
    fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));

    return serverPath;
}

// === Installation des dépendances système ===
async function installSystemDependencies() {
    socket.emit("task_log", "💻 Installation des dépendances système...");
    try {
        execSync(`
            sudo apt update &&
            sudo apt install -y curl wget unzip xz-utils tar git sudo openssh-server mysql-server mysql-client
        `, { stdio: "inherit" });

        execSync(`sudo systemctl enable ssh && sudo systemctl start ssh`, { stdio: "inherit" });

        socket.emit("task_log", "✅ Dépendances système installées !");
    } catch (err) {
        socket.emit("task_log", `❌ Erreur dépendances système : ${err.message}`);
        throw err;
    }
}

// === Téléchargement FiveM ===
async function downloadFivemServer(version, serverPath) {
    const url = `https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/${version}/fx.tar.xz`;
    socket.emit("task_log", `🌐 Téléchargement de FiveM depuis ${url}`);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Erreur téléchargement : ${res.status}`);

    const buffer = await res.arrayBuffer();
    const filePath = path.join(serverPath, `fivem_${version}.tar.xz`);
    fs.writeFileSync(filePath, Buffer.from(buffer));

    socket.emit("task_log", `✅ Téléchargement terminé : ${filePath}`);
}

// === Décompression du serveur FiveM ===
async function extractFivemServer(filePath, serverPath) {
    socket.emit("task_log", `📦 Décompression de ${path.basename(filePath)}...`);
    try {
        await decompress(filePath, serverPath, { plugins: [decompressTarxz()] });
        fs.unlinkSync(filePath);
        socket.emit("task_log", `✅ Décompression terminée et fichier supprimé : ${path.basename(filePath)}`);
    } catch (err) {
        socket.emit("task_log", `❌ Erreur décompression : ${err.message}`);
        throw err;
    }
}

// === Création d'un utilisateur Linux pour le serveur et SFTP ===
async function setupSFTPUser(serverId) {
    socket.emit("task_log", "🔑 Configuration utilisateur SFTP...");
    try {
        const username = `server_${serverId}`;
        const password = Math.random().toString(36).slice(-10);
        const serverPath = `/home/ubuntu/agentsystem/servers/server_${serverId}`;

        // Dossiers
        if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });
        const dataDir = path.join(serverPath, "data");
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

        // Créer utilisateur système
        execSync(`
            sudo useradd -m -d /home/${username} -s /usr/sbin/nologin ${username} || true
            echo "${username}:${password}" | sudo chpasswd
        `);

        // Config SSH chroot
        const sshdConfig = `
Match User ${username}
    ChrootDirectory ${serverPath}
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
`;
        execSync(`echo "${sshdConfig}" | sudo tee -a /etc/ssh/sshd_config`);
        execSync(`sudo systemctl restart ssh`);

        // Permissions
        execSync(`sudo chown root:root ${serverPath}`);
        execSync(`sudo chmod 755 ${serverPath}`);
        execSync(`sudo chown ${username}:${username} ${dataDir}`);

        socket.emit("task_log", `✅ Utilisateur SFTP créé : ${username} (${password})`);
        return { username, password, path: serverPath };
    } catch (err) {
        socket.emit("task_log", `❌ Erreur création SFTP : ${err.message}`);
        throw err;
    }
}

// === Configuration base de données MySQL ===
async function setupDatabase(serverId) {
    socket.emit("task_log", "🗄️ Configuration de la base de données...");
    try {
        const dbName = `fivem_server_${serverId}`;
        const dbUser = `fivem_user_${serverId}`;
        const dbPass = Math.random().toString(36).slice(-12);

        execSync(`
            sudo mysql -e "CREATE DATABASE IF NOT EXISTS ${dbName};"
            sudo mysql -e "CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}';"
            sudo mysql -e "GRANT ALL PRIVILEGES ON ${dbName}.* TO '${dbUser}'@'localhost';"
            sudo mysql -e "FLUSH PRIVILEGES;"
        `, { stdio: "inherit" });

        socket.emit("task_log", `✅ Base créée : ${dbName} (user: ${dbUser})`);
        return { dbName, dbUser, dbPass };
    } catch (err) {
        socket.emit("task_log", `❌ Erreur DB : ${err.message}`);
        throw err;
    }
}

// === Gestion des tâches envoyées par le backend ===
socket.on("task_assign", async ({ task }) => {
    console.log("📥 Tâche reçue :", task);

    if (task.type === "install") {
        const { game_type, version, serverId } = task;

        try {
            socket.emit("task_log", `🔧 Installation de ${game_type} ${version}...`);
            await installSystemDependencies();

            const serverPath = await createServerFolder(serverId, game_type, version);

            const dbInfo = await setupDatabase(serverId);
            fs.writeFileSync(path.join(serverPath, "db.json"), JSON.stringify(dbInfo, null, 2));

            const sftpInfo = await setupSFTPUser(serverId);
            fs.writeFileSync(path.join(serverPath, "sftp.json"), JSON.stringify(sftpInfo, null, 2));

            if (game_type === "fivem") {
                await downloadFivemServer(version, serverPath);
                const filePath = path.join(serverPath, `fivem_${version}.tar.xz`);
                await extractFivemServer(filePath, serverPath);
            }

            socket.emit("task_done", { taskId: task.taskId, serverId, status: "success" });
            console.log(`✅ Installation terminée pour le serveur ${serverId}`);
        } catch (err) {
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "error", error: err.message });
            console.error("❌ Erreur lors de l'installation :", err);
        }
    }
});
