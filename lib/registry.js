/**
 * Operation registry — collects all operations for codegen and runtime use.
 */

import { captureOp, diffOp, crawlOp, readCaptureOp } from "./operations.js";

export const allOperations = [captureOp, diffOp, crawlOp, readCaptureOp];
