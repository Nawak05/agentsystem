const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const decompress = require("decompress");
const decompressTarxz = require("decompress-tarxz");
const { execSync } = require("child_process");

const BACKEND_URL = "https://universellhub-hosting.shop";
const AGENT_TOKEN = "TEST_AGENT_001"; // Doit correspondre à celui dans ta BDD (table agents)

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

// === Création d'un utilisateur Linux pour le serveur et SFTP ===
async function setupSFTPUser(serverId) {
    socket.emit("task_log", "🔑 Configuration dossier serveur...");
    try {
        const username = "agentuser";              // Utilisateur fixe
        const password = "Tester123";       // Mot de passe connu pour SFTP
        const homeDir = `/home/${username}`;
        const serverPath = path.join(homeDir, `server_${serverId}`);

        if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });
        execSync(`sudo chown -R ${username}:${username} ${serverPath}`);

        socket.emit("task_log", `✅ Dossier serveur prêt : ${serverPath}`);
        return { username, password, serverPath };
    } catch (err) {
        socket.emit("task_log", `❌ Erreur SFTP : ${err.message}`);
        throw err;
    }
}

// === Configuration base de données MySQL pour le serveur ===
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

// === Réception des tâches ===
socket.on("task_assign", async ({ task }) => {
    console.log("📥 Tâche reçue :", task);

    if (task.type === "install") {
        const { game_type, version, serverId } = task;

        try {
            socket.emit("task_log", `🔧 Installation de ${game_type} ${version}...`);

            // 1️⃣ Installer les dépendances système
            await installSystemDependencies();

            // 2️⃣ Créer utilisateur SFTP + home dédié
            const sftpInfo = await setupSFTPUser(serverId);
            const serverPath = sftpInfo.serverPath;

            // 3️⃣ Configurer la base de données MySQL
            const dbInfo = await setupDatabase(serverId);
            fs.writeFileSync(path.join(serverPath, "db.json"), JSON.stringify(dbInfo, null, 2));

            // 4️⃣ Créer le config.json
            const configFile = path.join(serverPath, "config.json");
            const defaultConfig = {
                game_type,
                version,
                created_at: new Date().toISOString(),
            };
            fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));

            // 5️⃣ Sauvegarder infos SFTP
            fs.writeFileSync(path.join(serverPath, "sftp.json"), JSON.stringify(sftpInfo, null, 2));

            // 6️⃣ Téléchargement et extraction du serveur FiveM
            if (game_type === "fivem") {
                await downloadFivemServer(version, serverPath);
                const filePath = path.join(serverPath, `fivem_${version}.tar.xz`);
                await extractFivemServer(filePath, serverPath);
            }

            // 7️⃣ Notifier le backend que la tâche est terminée
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "success" });
            console.log(`✅ Installation terminée pour le serveur ${serverId}`);
        } catch (err) {
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "error", error: err.message });
            console.error("❌ Erreur lors de l'installation :", err);
        }
    }
});
