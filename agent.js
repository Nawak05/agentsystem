const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const decompress = require("decompress");
const decompressTarxz = require("decompress-tarxz");
const { execSync } = require("child_process");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const BACKEND_URL = "https://universellhub-hosting.shop";
const AGENT_TOKEN = "TEST_AGENT_001";

// === Connexion socket ===
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

// === Création dossiers serveur ===
async function createServerFolder(serverId, gameType, version) {
    const basePath = path.join(__dirname, "servers");
    const serverPath = path.join(basePath, `server_${serverId}`);
    const metaPath = path.join(serverPath, "meta");

    [basePath, serverPath, metaPath].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
    });

    const configFile = path.join(metaPath, "config.json");
    const defaultConfig = { game_type: gameType, version, created_at: new Date().toISOString() };
    fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2), { mode: 0o660 });

    return { serverPath, metaPath };
}

// === Dépendances système ===
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

    const tmpFile = `/tmp/fivem_${version}.tar.xz`;
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(tmpFile, Buffer.from(buffer));

    const destFile = path.join(serverPath, `fivem_${version}.tar.xz`);
    fs.copyFileSync(tmpFile, destFile);
    fs.chmodSync(destFile, 0o660);

    socket.emit("task_log", `✅ Téléchargement terminé : ${destFile}`);
}

// === Décompression FiveM ===
async function extractFivemServer(version, serverPath) {
    const filePath = path.join(serverPath, `fivem_${version}.tar.xz`);
    socket.emit("task_log", `📦 Décompression de ${path.basename(filePath)}...`);
    try {
        await decompress(filePath, serverPath, { plugins: [decompressTarxz()] });
        fs.rmSync(filePath);
        socket.emit("task_log", "✅ Décompression terminée !");
    } catch (err) {
        socket.emit("task_log", `❌ Erreur décompression : ${err.message}`);
        throw err;
    }
}

// === SFTP (fichier d’info) ===
async function setupSFTPUser(serverId) {
    socket.emit("task_log", "🔑 Configuration utilisateur SFTP...");

    const serverPath = path.join(__dirname, "servers", `server_${serverId}`);
    const dataDir = path.join(serverPath, "data");

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o770 });

    const sftpInfo = {
        username: `server_${serverId}`,
        password: Math.random().toString(36).slice(-10),
        path: serverPath
    };

    const sftpFile = path.join(serverPath, "meta", "sftp.json");
    fs.writeFileSync(sftpFile, JSON.stringify(sftpInfo, null, 2), { mode: 0o666 });

    socket.emit("task_log", `✅ SFTP configuré : ${sftpInfo.username}`);
    return sftpInfo;
}

// === Base de données MySQL ===
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

// === Gestion des tâches ===
socket.on("task_assign", async ({ task }) => {
    console.log("📥 Tâche reçue :", task);

    if (task.type === "install") {
        const { game_type, version, serverId } = task;

        try {
            socket.emit("task_log", `🔧 Installation de ${game_type} ${version}...`);

            await installSystemDependencies();

            const { serverPath, metaPath } = await createServerFolder(serverId, game_type, version);

            const dbInfo = await setupDatabase(serverId);
            fs.writeFileSync(path.join(metaPath, "db.json"), JSON.stringify(dbInfo, null, 2), { mode: 0o660 });

            const sftpInfo = await setupSFTPUser(serverId);

            if (game_type === "fivem") {
                await downloadFivemServer(version, serverPath);
                await extractFivemServer(version, serverPath);
            }

            // Run.sh
            const runScript = `#!/bin/bash
cd ${serverPath}
bash run.sh
`;
            const runFile = path.join(serverPath, "run.sh");
            fs.writeFileSync(runFile, runScript, { mode: 0o770 });

            socket.emit("task_done", { taskId: task.taskId, serverId, status: "success" });
            console.log(`✅ Installation terminée pour le serveur ${serverId}`);
        } catch (err) {
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "error", error: err.message });
            console.error("❌ Erreur lors de l'installation :", err);
        }
    }
});
