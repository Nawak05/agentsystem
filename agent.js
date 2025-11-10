// agent.js
const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const BACKEND_URL = "https://universellhub-hosting.shop";
const AGENT_TOKEN = "TEST_AGENT_001";

const socket = io(BACKEND_URL, {
    path: "/agents",
    transports: ["websocket"]
});



async function createServerFolder(serverId, gameType, version) {
    const basePath = path.join(__dirname, "servers"); // dossier principal pour tous les serveurs
    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath);

    const serverPath = path.join(basePath, `server_${serverId}`);
    if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath);

    // Créer un fichier config.json de base
    const configFile = path.join(serverPath, "config.json");
    const defaultConfig = { game_type: gameType, version, created_at: new Date().toISOString() };
    fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));

    return serverPath;
}


async function downloadFivemServer(version, serverPath) {
    const url = `https://runtime.fivem.net/artifacts/fivem/build_proot_linux/master/${version}/fx.tar.xz`; // exemple
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Erreur téléchargement : ${res.status}`);

    const buffer = await res.arrayBuffer();
    fs.writeFileSync(path.join(serverPath, `fivem_${version}.tar.xz`), Buffer.from(buffer));
}


socket.on("connect", () => {
    console.log("🔌 Connecté au backend !");
    socket.emit("auth", { token: AGENT_TOKEN });
});

socket.on("auth_ok", () => console.log("✅ Auth OK"));
socket.on("auth_error", (e) => console.log("❌ Auth échouée :", e.message));
socket.on("disconnect", () => console.log("❌ Déconnecté"));

socket.on("task_assign", async ({ task }) => {
    console.log("📥 Tâche reçue :", task);

    if (task.type === "install") {
        const { game_type, version, serverId } = task;

        try {
            socket.emit("task_log", `🔧 Installation de ${game_type} ${version}...`);

            // Créer le dossier serveur
            const serverPath = await createServerFolder(serverId, game_type, version);
            socket.emit("task_log", `📂 Dossier créé : ${serverPath}`);

            // Télécharger / installer les fichiers
            if (game_type === "fivem") {
                await downloadFivemServer(version, serverPath);
                socket.emit("task_log", `✅ Fichiers téléchargés pour ${game_type} ${version}`);
            }

            // Fin de la tâche
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "success" });
            console.log(`✅ Installation terminée pour le serveur ${serverId}`);
        } catch (err) {
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "error", error: err.message });
            console.error("❌ Erreur lors de l'installation :", err);
        }
    }
});
