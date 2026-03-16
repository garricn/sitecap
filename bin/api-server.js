#!/usr/bin/env node

import { createServer } from "node:http";
import { handleRequest } from "../generated/api-routes.js";

const PORT = parseInt(process.env.SITECAP_PORT || "3100", 10);

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`sitecap API on :${PORT}`);
});

process.on("SIGINT", () => process.exit(0));
