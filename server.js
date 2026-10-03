// A tiny web server. It sends the files in "public" to the browser,
// and relays player positions between browsers using Socket.IO.
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = 3000;

// Any file inside the "public" folder can be requested by the browser.
// Visiting http://localhost:3000/ serves public/index.html automatically.
app.use(express.static("public"));

// Socket.IO needs the raw HTTP server that Express runs on, so we create it ourselves.
const server = http.createServer(app);
const io = new Server(server);

// Everyone currently connected, keyed by their socket id:
// { "abc123": { id: "abc123", x: 50, y: 300, color: "#ff8800" }, ... }
const players = {};

function randomColor() {
  return "hsl(" + Math.floor(Math.random() * 360) + ", 80%, 55%)";
}

// This runs once for every browser that connects.
io.on("connection", (socket) => {
  // 1. Add the new player to the list
  players[socket.id] = { id: socket.id, x: 50, y: 300, color: randomColor() };

  // 2. Tell the new player about everyone (including themselves, so they learn their color)
  socket.emit("currentPlayers", players);

  // 3. Tell everyone else that someone new arrived
  socket.broadcast.emit("newPlayer", players[socket.id]);

  // 4. Whenever this player moves, save it and pass it on to everyone else
  socket.on("move", (pos) => {
    const p = players[socket.id];
    if (!p) return;
    p.x = pos.x;
    p.y = pos.y;
    socket.broadcast.emit("playerMoved", { id: socket.id, x: p.x, y: p.y });
  });

  // 5. When they close the tab, remove them and tell everyone
  socket.on("disconnect", () => {
    delete players[socket.id];
    io.emit("playerLeft", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Game running at http://localhost:${PORT}`);
});
