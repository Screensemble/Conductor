// Player addon WebSocket endpoint. One persistent connection per player, used
// for commands, state reports, readiness, and (Controlled mode) the Arm/Go
// sequence plus the NTP-style time-sync exchange. See spec sections 2 and 4.
export function handlePlayerConnection(ws, req) {
  const remote = req.socket.remoteAddress;
  console.log(`player connected: ${remote}`);

  ws.on('message', (data) => {
    // TODO: message dispatch — enrollment, state/capability reports, READY,
    // time-sync offset exchange.
    console.log(`player message from ${remote}: ${data}`);
  });

  ws.on('close', () => {
    console.log(`player disconnected: ${remote}`);
  });
}
