#!/usr/bin/env node
/**
 * probe-sdk.mjs — 用 DSH 自己用的 @modelcontextprotocol/sdk (1.30.0) 客户端
 * 连一次 server.mjs，等价于 DSH 启动时 dsh-mcp-client 做的事。
 *
 * 需要子进程管道 stdio，因此在 DSH 沙箱内会 spawn EPERM，测试时以完整权限运行一次。
 */
import { createRequire } from "node:module";

const require = createRequire("C:/Users/28256/.dsh/profiles/desktop/package.json");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const transport = new StdioClientTransport({
  command: "C:\\Program Files\\nodejs\\node.exe",
  args: ["C:\\Users\\28256\\.dsh\\mcp\\comfyui-mcp\\server.mjs"],
  cwd: "C:\\Users\\28256\\.dsh\\mcp\\comfyui-mcp",
});

const client = new Client({ name: "dsh-mcp-probe", version: "1.0.0" });
await client.connect(transport);
console.log("已连接，协商协议版本：", client.getServerVersion?.() ? "n/a" : "n/a");

const tools = await client.listTools();
console.log("工具列表：");
for (const t of tools.tools) console.log(`  - ${t.name}`);

const status = await client.callTool({ name: "service_status", arguments: {} });
console.log("service_status →", status.content?.[0]?.text?.slice(0, 260));

await client.close();
console.log("\nSDK 客户端连接与调用全部正常 —— 重启 DSH Desktop 后工具会以 mcp__comfyui__* 出现。");
process.exit(0);
