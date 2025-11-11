// agent.js
const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const decompress = require("decompress");
const decompressTarxz = require("decompress-tarxz");
const { execSync } = require("child_process");

const BACKEND_URL = "https://universellhub-hosting.shop";
const AGENT_TOKEN = "TEST_AGENT_001";

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

// === Installation dépendances système ===
async function installSystemDependencies() {
    socket.emit("task_log", "💻 Installation des dépendances système...");
    try {
        execSync(`
            apt update &&
            apt install -y curl wget unzip xz-utils tar git sudo openssh-server mysql-server mysql-client
        `, { stdio: "inherit" });

        execSync("systemctl enable ssh && systemctl start ssh", { stdio: "inherit" });

        socket.emit("task_log", "✅ Dépendances système installées !");
    } catch (err) {
        socket.emit("task_log", `❌ Erreur lors de l'installation des dépendances : ${err.message}`);
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

// === Décompression FiveM ===
async function extractFivemServer(filePath, serverPath) {
    socket.emit("task_log", `📦 Décompression de ${path.basename(filePath)}...`);

    try {
        await decompress(filePath, serverPath, { plugins: [decompressTarxz()] });
        fs.unlinkSync(filePath);
        socket.emit("task_log", `✅ Décompression terminée et fichier supprimé`);
    } catch (err) {
        socket.emit("task_log", `❌ Erreur lors de la décompression : ${err.message}`);
        throw err;
    }
}

// === Création utilisateur SFTP ===
async function setupSFTPUser(serverId, serverPath) {
    socket.emit("task_log", "🔑 Création utilisateur SFTP pour le serveur...");
    try {
        const username = `fivem_${serverId}`;
        const password = Math.random().toString(36).slice(-12);

        execSync(`useradd -m -d ${serverPath} -s /usr/sbin/nologin ${username} || true`);
        execSync(`echo "${username}:${password}" | chpasswd`);

        socket.emit("task_log", `✅ Utilisateur SFTP créé : ${username} / ${password}`);
        return { username, password };
    } catch (err) {
        socket.emit("task_log", `❌ Erreur création utilisateur SFTP : ${err.message}`);
        throw err;
    }
}

// === Configuration DB ===
async function setupDatabase(serverId) {
    socket.emit("task_log", "🗄️ Configuration de la base de données...");
    try {
        const dbName = `fivem_server_${serverId}`;
        const dbUser = `fivem_user_${serverId}`;
        const dbPass = Math.random().toString(36).slice(-12);

        execSync(`
            mysql -e "CREATE DATABASE IF NOT EXISTS ${dbName};"
            mysql -e "CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}';"
            mysql -e "GRANT ALL PRIVILEGES ON ${dbName}.* TO '${dbUser}'@'localhost';"
            mysql -e "FLUSH PRIVILEGES;"
        `, { stdio: "inherit" });

        socket.emit("task_log", `✅ Base de données créée : ${dbName}`);
        return { dbName, dbUser, dbPass };
    } catch (err) {
        socket.emit("task_log", `❌ Erreur DB : ${err.message}`);
        throw err;
    }
}

// === Réception des tâches ===
socket.on("task_assign", async ({ task }) => {
    if (task.type === "install") {
        const { game_type, version, serverId } = task;
        try {
            socket.emit("task_log", `🔧 Installation de ${game_type} ${version}...`);

            await installSystemDependencies();
            const serverPath = await createServerFolder(serverId, game_type, version);

            const dbInfo = await setupDatabase(serverId);
            fs.writeFileSync(path.join(serverPath, "db.json"), JSON.stringify(dbInfo, null, 2));

            const sftpInfo = await setupSFTPUser(serverId, serverPath);
            fs.writeFileSync(path.join(serverPath, "sftp.json"), JSON.stringify(sftpInfo, null, 2));

            if (game_type === "fivem") {
                await downloadFivemServer(version, serverPath);
                const filePath = path.join(serverPath, `fivem_${version}.tar.xz`);
                await extractFivemServer(filePath, serverPath);
            }

            socket.emit("task_log", `🧩 Installation terminée !`);
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "success" });
        } catch (err) {
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "error", error: err.message });
        }
    }
});
