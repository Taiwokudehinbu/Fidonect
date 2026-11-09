// Vercel serverless entry point.
// The Express app stays in backend/server.js unchanged (Render keeps working);
// Vercel imports it here and handles one request per invocation.
module.exports = require("../backend/server.js");
