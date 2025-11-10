// agent.js
const { io } = require("socket.io-client");

const BACKEND_URL = "https://universellhub-hosting.shop";
const AGENT_TOKEN = "TEST_AGENT_001";

const socket = io(BACKEND_URL, {
    path: "/agents",
    transports: ["websocket"]
});

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
            // 1️⃣ Log au client
            socket.emit("task_log", `🔧 Installation de ${game_type} ${version}...`);

            // 2️⃣ Simulation de l'installation (ici tu mets ton code réel SSH/SFTP)
            // Ex: utiliser child_process pour exécuter des commandes sur le serveur
            // const { exec } = require('child_process');
            // exec(`install_fivem.sh ${version}`, (err, stdout, stderr) => { ... });

            // Exemple simulation
            for (let i = 1; i <= 5; i++) {
                await new Promise(r => setTimeout(r, 1000));
                socket.emit("task_log", `📦 Progression : ${i * 20}%`);
            }

            // 3️⃣ Task terminée
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "success" });
            console.log(`✅ Installation terminée pour le serveur ${serverId}`);
        } catch (err) {
            socket.emit("task_done", { taskId: task.taskId, serverId, status: "error", error: err.message });
            console.error("❌ Erreur lors de l'installation :", err);
        }
    } else {
        // Task générique
        await new Promise(r => setTimeout(r, 2000));
        socket.emit("task_done", { taskId: task.taskId, serverId: task.serverId, status: "success" });
    }
});
