// agent.js
const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const decompress = require("decompress");


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
        await decompress(filePath, serverPath);
        socket.emit("task_log", "✅ Décompression terminée !");
    } catch (err) {
        socket.emit("task_log", `❌ Erreur lors de la décompression : ${err.message}`);
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

            // Crée le dossier du serveur
            const serverPath = await createServerFolder(serverId, game_type, version);
            socket.emit("task_log", `📂 Dossier créé : ${serverPath}`);

            // Télécharge les fichiers si c'est du FiveM
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
