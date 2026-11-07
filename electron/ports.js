// Network ports in one place. Keep in step with scripts/orbit-common.ps1 and TakeoverServer.cs.
module.exports = {
  ENGINE_TAKEOVER_PORT: 47995, // Orbit's engine on the PC, reached from the Mac
  ENGINE_ADMIN_PORT: 47990, // Orbit's engine, reachable only from the PC itself
  // Sunshine has to move off its default base port 47989, because its web page port (base + 1) is Orbit's 47990.
  SUNSHINE_BASE_PORT: 48989,
};
