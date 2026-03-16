// AUTO-GENERATED — do not edit. Run: npm run generate
import { captureOp, diffOp, crawlOp, readCaptureOp } from "../lib/operations.js";

export const tools = [
  {
    "name": "capture",
    "description": "Capture a web page — screenshot, accessibility tree, HTML, network, console, storage, performance",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "URL to capture"
        },
        "output": {
          "default": "/tmp/sitecap",
          "description": "Output directory",
          "type": "string"
        },
        "types": {
          "description": "Comma-separated capture types",
          "type": "string"
        },
        "viewport": {
          "default": "1280x720",
          "description": "Viewport WxH",
          "type": "string"
        }
      },
      "required": [
        "url",
        "output",
        "viewport"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "diff",
    "description": "Compare two sitecap capture directories",
    "inputSchema": {
      "type": "object",
      "properties": {
        "dirA": {
          "type": "string",
          "description": "Path to first capture directory"
        },
        "dirB": {
          "type": "string",
          "description": "Path to second capture directory"
        },
        "threshold": {
          "description": "Screenshot diff threshold % (default: 0.1)",
          "type": "number"
        }
      },
      "required": [
        "dirA",
        "dirB"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "crawl",
    "description": "Crawl a site and capture all same-origin pages",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "Seed URL to crawl from"
        },
        "output": {
          "default": "/tmp/sitecap",
          "description": "Output directory",
          "type": "string"
        },
        "maxDepth": {
          "default": 3,
          "description": "Max crawl depth",
          "type": "number"
        },
        "maxPages": {
          "default": 50,
          "description": "Max pages to capture",
          "type": "number"
        },
        "filter": {
          "description": "Regex to include URLs",
          "type": "string"
        },
        "exclude": {
          "description": "Regex to exclude URLs",
          "type": "string"
        }
      },
      "required": [
        "url",
        "output",
        "maxDepth",
        "maxPages"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "read_capture",
    "description": "Read a specific file from a sitecap capture directory",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Path to the capture file"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false
    }
  }
];

const ops = { capture: captureOp, diff: diffOp, crawl: crawlOp, read_capture: readCaptureOp };

export async function handleTool(name, args) {
  const op = ops[name];
  if (!op) throw new Error(`Unknown tool: ${name}`);
  return op.handler(op.input.parse(args));
}
