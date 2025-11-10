// agent.js
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



async function installSystemDependencies() {
    socket.emit("task_log", "💻 Installation des dépendances système...");
    try {
        // Met à jour la machine et installe tout ce dont on a besoin
        execSync(`
            sudo apt update &&
            sudo apt install -y curl wget unzip xz-utils tar git sudo openssh-server mysql-server mysql-client
        `, { stdio: "inherit" });

        // Active le service SSH
        execSync("sudo systemctl enable ssh && sudo systemctl start ssh", { stdio: "inherit" });

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


// === Décompression du serveur FiveM ===

async function extractFivemServer(filePath, serverPath) {
    socket.emit("task_log", `📦 Décompression de ${path.basename(filePath)}...`);

    try {
        await decompress(filePath, serverPath, {
            plugins: [decompressTarxz()]
        });

        // Supprimer le fichier après extraction
        fs.unlinkSync(filePath);
        socket.emit("task_log", `✅ Décompression terminée et fichier supprimé : ${path.basename(filePath)}`);
        console.log("✅ Décompression terminée et fichier supprimé :", serverPath);
    } catch (err) {
        socket.emit("task_log", `❌ Erreur lors de la décompression : ${err.message}`);
        console.error("❌ Erreur lors de la décompression :", err);
        throw err;
    }
}

// === Création d'un utilisateur Linux pour le serveur et SFTP ===
async function setupSFTPUser(serverId, serverPath) {
    socket.emit("task_log", "🔑 Création utilisateur SFTP pour le serveur...");

    try {
        const username = `fivem_${serverId}`;
        const password = Math.random().toString(36).slice(-12); // mot de passe aléatoire

        // 1️⃣ Crée l'utilisateur système sans shell, avec dossier home dans serverPath
        execSync(`
            sudo useradd -m -d ${serverPath} -s /usr/sbin/nologin ${username} || true
        `);

        // 2️⃣ Définit le mot de passe
        execSync(`echo "${username}:${password}" | sudo chpasswd`);

        // 3️⃣ Limite l'accès SFTP (chroot) dans sshd_config si nécessaire
        // On suppose que le dossier est déjà le home du user, donc chroot automatique

        socket.emit("task_log", `✅ Utilisateur SFTP créé : ${username} / ${password}`);
        return { username, password };
    } catch (err) {
        socket.emit("task_log", `❌ Erreur lors de la création utilisateur SFTP : ${err.message}`);
        throw err;
    }
}


// === Configuration base de données MySQL pour le serveur ===
async function setupDatabase(serverId) {
    socket.emit("task_log", "🗄️ Configuration de la base de données...");

    try {
        const dbName = `fivem_server_${serverId}`;
        const dbUser = `fivem_user_${serverId}`;
        const dbPass = Math.random().toString(36).slice(-12); // mot de passe aléatoire

        // Crée la base et l'utilisateur MySQL
        execSync(`
            sudo mysql -e "CREATE DATABASE IF NOT EXISTS ${dbName};"
            sudo mysql -e "CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}';"
            sudo mysql -e "GRANT ALL PRIVILEGES ON ${dbName}.* TO '${dbUser}'@'localhost';"
            sudo mysql -e "FLUSH PRIVILEGES;"
        `, { stdio: "inherit" });

        socket.emit("task_log", `✅ Base de données créée : ${dbName} (user: ${dbUser})`);
        return { dbName, dbUser, dbPass };
    } catch (err) {
        socket.emit("task_log", `❌ Erreur DB : ${err.message}`);
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

            // 1️⃣ Installer les dépendances systèmes
            await installSystemDependencies();

            // 2️⃣ Crée le dossier du serveur
            const serverPath = await createServerFolder(serverId, game_type, version);
            socket.emit("task_log", `📂 Dossier créé : ${serverPath}`);

            // 3️⃣ Config DB
            const dbInfo = await setupDatabase(serverId);
            fs.writeFileSync(path.join(serverPath, "db.json"), JSON.stringify(dbInfo, null, 2));
            socket.emit("task_log", "💾 Informations DB sauvegardées dans db.json");

            // 4️⃣ Création utilisateur SFTP
            const sftpInfo = await setupSFTPUser(serverId, serverPath);
            fs.writeFileSync(path.join(serverPath, "sftp.json"), JSON.stringify(sftpInfo, null, 2));
            socket.emit("task_log", "💾 Informations SFTP sauvegardées dans sftp.json");


            // 3️⃣ Télécharge + décompresse FiveM
            if (game_type === "fivem") {
                await downloadFivemServer(version, serverPath);
                const filePath = path.join(serverPath, `fivem_${version}.tar.xz`);
                await extractFivemServer(filePath, serverPath);
            }

            socket.emit("task_log", `🧩 Configuration terminée !`);
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "success" });
            console.log(`✅ Installation terminée pour le serveur ${serverId}`);
        } catch (err) {
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "error", error: err.message });
            console.error("❌ Erreur lors de l'installation :", err);
        }
    }

});
