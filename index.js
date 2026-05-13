import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import fsSync from "fs";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec, execFile } from "child_process";
import { promisify } from "util";

const app = express();

app.use(cors());
app.use(express.json());

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 4000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================================================
   FILE LOCATIONS
   ========================================================= */

const LOCAL_PRINTERS_FILE = path.join(__dirname, "data", "printers.json");
const PI_PRINTERS_FILE = "/home/fieldlab/Desktop/bambu-fiware/printers.json";

const PRINTERS_FILE =
  process.env.PRINTERS_FILE ||
  (fsSync.existsSync(PI_PRINTERS_FILE) ? PI_PRINTERS_FILE : LOCAL_PRINTERS_FILE);

/* =========================================================
   BRIDGE / FIWARE / MQTT VALIDATION CONFIG
   ========================================================= */

const BRIDGE_SERVICE_NAME = process.env.BRIDGE_SERVICE_NAME || "bambu-bridge";

const AUTO_RESTART_BRIDGE_ON_SAVE =
  String(process.env.AUTO_RESTART_BRIDGE_ON_SAVE || "true").toLowerCase() ===
  "true";

const VALIDATE_MQTT_ON_SAVE =
  String(process.env.VALIDATE_MQTT_ON_SAVE || "true").toLowerCase() === "true";

const MQTT_VALIDATOR_SCRIPT =
  process.env.MQTT_VALIDATOR_SCRIPT ||
  path.join(__dirname, "validate_bambu_mqtt.py");

const MQTT_VALIDATOR_PYTHON =
  process.env.MQTT_VALIDATOR_PYTHON ||
  "/home/fieldlab/Desktop/bambu-fiware/venv/bin/python3";

const MQTT_VALIDATION_TIMEOUT_SECONDS = Number(
  process.env.MQTT_VALIDATION_TIMEOUT_SECONDS || 6
);

const FIWARE_ENTITY_URL =
  process.env.FIWARE_ENTITY_URL ||
  "http://172.16.101.172:1026/ngsi-ld/v1/entities?type=Printer";

const DEFAULT_FIWARE_ENDPOINT =
  process.env.DEFAULT_FIWARE_ENDPOINT ||
  "http://172.16.101.172:1026/ngsi-ld/v1/entities";

/* =========================================================
   FIWARE HELPERS
   ========================================================= */

function getFiwareHeaders() {
  return {
    Accept: "application/ld+json",
    "fiware-service": "openiot",
    "fiware-servicepath": "/",
  };
}

async function fetchFiwarePrintersSafe() {
  try {
    const response = await fetch(FIWARE_ENTITY_URL, {
      headers: getFiwareHeaders(),
    });

    if (!response.ok) {
      const text = await response.text();

      return {
        data: [],
        error: `FIWARE request failed: ${response.status} ${text}`,
      };
    }

    const data = await response.json();

    return {
      data: Array.isArray(data) ? data : [],
      error: null,
    };
  } catch (err) {
    console.error("FIWARE fetch failed:", err);

    return {
      data: [],
      error: err.message,
    };
  }
}

/* =========================================================
   FILE HELPERS
   ========================================================= */

async function ensurePrintersFileExists() {
  const dir = path.dirname(PRINTERS_FILE);
  await fs.mkdir(dir, { recursive: true });

  if (!fsSync.existsSync(PRINTERS_FILE)) {
    const initialData = {
      last_updated: new Date().toISOString(),
      fiware_endpoint: DEFAULT_FIWARE_ENDPOINT,
      printers: [],
    };

    await fs.writeFile(
      PRINTERS_FILE,
      JSON.stringify(initialData, null, 2),
      "utf-8"
    );
  }
}

async function readPrintersFile() {
  await ensurePrintersFileExists();

  const raw = await fs.readFile(PRINTERS_FILE, "utf-8");
  return JSON.parse(raw);
}

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;

  await fs.mkdir(dir, { recursive: true });

  if (fsSync.existsSync(filePath)) {
    const previous = await fs.readFile(filePath, "utf-8");
    await fs.writeFile(backupPath, previous, "utf-8");
  }

  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
}

/* =========================================================
   PRINTER CONFIG HELPERS
   ========================================================= */

function sanitizePrinter(input = {}, existing = {}) {
  return {
    id: String(input.id ?? existing.id ?? "").trim(),
    name: String(input.name ?? existing.name ?? "").trim(),
    ip: String(input.ip ?? existing.ip ?? "").trim(),
    access_code: String(input.access_code ?? existing.access_code ?? "").trim(),
    serial: String(input.serial ?? existing.serial ?? "").trim(),

    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : typeof existing.enabled === "boolean"
        ? existing.enabled
        : true,

    is_pipeline_healthy:
      typeof input.is_pipeline_healthy === "boolean"
        ? input.is_pipeline_healthy
        : typeof existing.is_pipeline_healthy === "boolean"
        ? existing.is_pipeline_healthy
        : false,

    health_message:
      input.health_message ??
      existing.health_message ??
      "No health status yet",

    last_error: input.last_error ?? existing.last_error ?? null,
    last_error_at: input.last_error_at ?? existing.last_error_at ?? null,

    last_seen: input.last_seen ?? existing.last_seen ?? null,

    last_updated:
      input.last_updated ?? existing.last_updated ?? new Date().toISOString(),
  };
}

function isValidIPv4(ip) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return false;
  }

  return ip.split(".").every((part) => {
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255;
  });
}

function validatePrinter(printer, index = null) {
  const prefix =
    index === null
      ? `${printer.name || printer.id || "Printer"}`
      : `Printer ${index + 1}`;

  const errors = [];

  if (!printer.id) errors.push(`${prefix}: missing id`);
  if (!printer.name) errors.push(`${prefix}: missing name`);
  if (!printer.ip) errors.push(`${prefix}: missing ip`);
  if (printer.ip && !isValidIPv4(printer.ip)) {
    errors.push(`${prefix}: invalid ip`);
  }
  if (!printer.access_code) errors.push(`${prefix}: missing access_code`);
  if (!printer.serial) errors.push(`${prefix}: missing serial`);

  return errors;
}

function assertSafeServiceName(name) {
  if (!/^[a-zA-Z0-9_.@-]+$/.test(name)) {
    throw new Error(`Unsafe systemd service name: ${name}`);
  }
}

function markPrinterAfterSuccessfulValidation(existingPrinter, updates = {}) {
  const now = new Date().toISOString();

  return {
    ...existingPrinter,
    ...updates,
    last_updated: now,
    is_pipeline_healthy: true,
    health_message:
      "MQTT access code accepted. Bridge restart requested. Waiting for fresh FIWARE telemetry.",
    last_error: null,
    last_error_at: null,
  };
}

/* =========================================================
   MQTT ACCESS-CODE VALIDATION
   ========================================================= */

function parseValidatorJson(stdout = "") {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch (_err) {
      // Ignore non-JSON lines such as warnings.
    }
  }

  return null;
}

async function validateBambuMqttAccess(printer) {
  if (!VALIDATE_MQTT_ON_SAVE) {
    return {
      ok: true,
      skipped: true,
      reason: "VALIDATION_DISABLED",
      message: "MQTT validation is disabled.",
    };
  }

  if (!printer.enabled) {
    return {
      ok: true,
      skipped: true,
      reason: "PRINTER_DISABLED",
      message: "Printer is disabled, so MQTT validation was skipped.",
    };
  }

  if (!fsSync.existsSync(MQTT_VALIDATOR_SCRIPT)) {
    return {
      ok: false,
      reason: "VALIDATOR_SCRIPT_MISSING",
      message: `MQTT validator script was not found: ${MQTT_VALIDATOR_SCRIPT}`,
    };
  }

  if (!fsSync.existsSync(MQTT_VALIDATOR_PYTHON)) {
    return {
      ok: false,
      reason: "VALIDATOR_PYTHON_MISSING",
      message: `MQTT validator Python was not found: ${MQTT_VALIDATOR_PYTHON}`,
    };
  }

  const args = [
    MQTT_VALIDATOR_SCRIPT,
    "--ip",
    printer.ip,
    "--serial",
    printer.serial,
    "--access-code",
    printer.access_code,
    "--timeout",
    String(MQTT_VALIDATION_TIMEOUT_SECONDS),
  ];

  try {
    const { stdout, stderr } = await execFileAsync(
      MQTT_VALIDATOR_PYTHON,
      args,
      {
        timeout: Math.max(10, MQTT_VALIDATION_TIMEOUT_SECONDS + 4) * 1000,
        maxBuffer: 1024 * 1024,
      }
    );

    const parsed = parseValidatorJson(stdout);

    if (!parsed) {
      return {
        ok: false,
        reason: "VALIDATOR_BAD_OUTPUT",
        message: "MQTT validator did not return valid JSON.",
        stdout: stdout?.trim?.() || "",
        stderr: stderr?.trim?.() || "",
      };
    }

    return {
      ...parsed,
      stderr: stderr?.trim?.() || "",
    };
  } catch (err) {
    const parsed = parseValidatorJson(err?.stdout || "");

    if (parsed) {
      return {
        ...parsed,
        stderr: err?.stderr?.trim?.() || "",
      };
    }

    return {
      ok: false,
      reason: "VALIDATOR_COMMAND_FAILED",
      message:
        err?.message ||
        "MQTT validator command failed before returning JSON.",
      stdout: err?.stdout?.trim?.() || "",
      stderr: err?.stderr?.trim?.() || "",
    };
  }
}

/* =========================================================
   BRIDGE HELPERS
   ========================================================= */

async function restartBridgeService() {
  if (process.platform !== "linux") {
    return {
      ok: true,
      skipped: true,
      message: "Restart skipped outside Linux",
    };
  }

  assertSafeServiceName(BRIDGE_SERVICE_NAME);

  const { stdout, stderr } = await execAsync(
    `sudo systemctl restart ${BRIDGE_SERVICE_NAME}`
  );

  return {
    ok: true,
    skipped: false,
    message: `Bridge service '${BRIDGE_SERVICE_NAME}' restarted`,
    stdout: stdout?.trim() || "",
    stderr: stderr?.trim() || "",
  };
}

async function getBridgeStatus() {
  if (process.platform !== "linux") {
    return {
      ok: true,
      active: null,
      raw: "unknown",
      message: "Bridge status unavailable outside Linux",
    };
  }

  assertSafeServiceName(BRIDGE_SERVICE_NAME);

  try {
    const { stdout } = await execAsync(
      `systemctl is-active ${BRIDGE_SERVICE_NAME}`
    );

    return {
      ok: true,
      active: stdout.trim() === "active",
      raw: stdout.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      active: false,
      raw: error?.stdout?.trim?.() || "inactive",
      error: error?.stderr?.trim?.() || error.message,
    };
  }
}

/* =========================================================
   PRINTER CONFIG HANDLERS
   ========================================================= */

async function getPrinterConfigHandler(_req, res) {
  try {
    const config = await readPrintersFile();
    return res.json(config);
  } catch (err) {
    console.error("GET /api/printer-config failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Failed to read printer config",
      details: err.message,
      file: PRINTERS_FILE,
    });
  }
}

async function putPrinterConfigHandler(req, res) {
  try {
    const body = req.body;

    if (!body || !Array.isArray(body.printers)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload. Expected { printers: [...] }",
      });
    }

    const currentConfig = await readPrintersFile();

    const printers = body.printers.map((incoming, index) => {
      const existing =
        currentConfig.printers.find((p) => p.id === incoming.id) || {};

      const merged = sanitizePrinter(incoming, existing);
      const errors = validatePrinter(merged, index);

      if (errors.length > 0) {
        throw new Error(errors.join("; "));
      }

      return markPrinterAfterSuccessfulValidation(merged);
    });

    const duplicateIds = [];
    const seen = new Set();

    for (const printer of printers) {
      if (seen.has(printer.id)) {
        duplicateIds.push(printer.id);
      }

      seen.add(printer.id);
    }

    if (duplicateIds.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `Duplicate printer ids: ${Array.from(
          new Set(duplicateIds)
        ).join(", ")}`,
      });
    }

    const now = new Date().toISOString();

    const payload = {
      ...currentConfig,
      ...body,
      fiware_endpoint:
        body.fiware_endpoint ||
        currentConfig.fiware_endpoint ||
        DEFAULT_FIWARE_ENDPOINT,
      printers,
      last_updated: now,
    };

    await writeJsonAtomic(PRINTERS_FILE, payload);

    let restart = {
      ok: true,
      skipped: true,
      message: "Auto-restart disabled",
    };

    if (AUTO_RESTART_BRIDGE_ON_SAVE) {
      restart = await restartBridgeService();
    }

    return res.json({
      ok: true,
      message: "Printer config updated successfully",
      file: PRINTERS_FILE,
      last_updated: payload.last_updated,
      restart,
      config: payload,
    });
  } catch (err) {
    console.error("PUT /api/printer-config failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Failed to update printer config",
      details: err.message,
      file: PRINTERS_FILE,
    });
  }
}

async function patchPrinterConfigHandler(req, res) {
  try {
    const printerId = req.params.id;
    const { ip, access_code, enabled } = req.body || {};

    const config = await readPrintersFile();

    if (!config || !Array.isArray(config.printers)) {
      return res.status(500).json({
        ok: false,
        error: "Invalid printer config structure",
      });
    }

    const index = config.printers.findIndex((p) => p.id === printerId);

    if (index === -1) {
      return res.status(404).json({
        ok: false,
        error: "Printer not found",
      });
    }

    const existing = config.printers[index];

    const merged = sanitizePrinter(
      {
        ...existing,
        ...(typeof ip === "string" ? { ip: ip.trim() } : {}),
        ...(typeof access_code === "string"
          ? { access_code: access_code.trim() }
          : {}),
        ...(typeof enabled === "boolean" ? { enabled } : {}),
      },
      existing
    );

    const validationErrors = validatePrinter(merged);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Validation failed",
        details: validationErrors.join("; "),
      });
    }

    const mqttValidation = await validateBambuMqttAccess(merged);

    if (!mqttValidation.ok) {
      const isAccessCodeInvalid =
        mqttValidation.reason === "ACCESS_CODE_INVALID";

      return res.status(400).json({
        ok: false,
        error: isAccessCodeInvalid
          ? "Access code invalid"
          : "MQTT validation failed",
        details:
          mqttValidation.message ||
          "Could not validate MQTT connection for this printer.",
        validation: mqttValidation,

        /*
          Important:
          We return current config unchanged.
          We do NOT save the wrong access code.
          We do NOT restart the bridge with a bad code.
        */
        config,
      });
    }

    const updatedPrinter = markPrinterAfterSuccessfulValidation(merged, {
      is_pipeline_healthy: true,
      health_message:
        mqttValidation.message ||
        "MQTT access code accepted. Waiting for bridge restart.",
      last_error: null,
      last_error_at: null,
    });

    config.printers[index] = updatedPrinter;
    config.last_updated = updatedPrinter.last_updated;

    await writeJsonAtomic(PRINTERS_FILE, config);

    let restart = {
      ok: true,
      skipped: true,
      message: "Auto-restart disabled",
    };

    if (AUTO_RESTART_BRIDGE_ON_SAVE) {
      restart = await restartBridgeService();
    }

    return res.json({
      ok: true,
      message: `Printer ${updatedPrinter.name} updated successfully`,
      printer: updatedPrinter,
      last_updated: config.last_updated,
      mqtt_validation: mqttValidation,
      restart,
      config,
    });
  } catch (err) {
    console.error("PATCH /api/printer-config/:id failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Failed to update printer config",
      details: err.message,
    });
  }
}

/* =========================================================
   LIVE DATA FROM FIWARE
   ========================================================= */

app.get("/api/printers", async (_req, res) => {
  const { data, error } = await fetchFiwarePrintersSafe();

  if (error && data.length === 0) {
    return res.status(500).json({
      ok: false,
      error: "FIWARE request failed",
      details: error,
    });
  }

  return res.json(data);
});

/* =========================================================
   RUNTIME STATE
   ========================================================= */

app.get("/api/printer-runtime", async (_req, res) => {
  try {
    const config = await readPrintersFile();
    const fiwareResult = await fetchFiwarePrintersSafe();
    const bridgeStatus = await getBridgeStatus().catch(() => null);

    return res.json({
      ok: true,
      config,
      printers: fiwareResult.data || [],
      warnings: {
        printersError: fiwareResult.error,
      },
      bridge_status: bridgeStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("GET /api/printer-runtime failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Printer runtime request failed",
      details: err.message,
    });
  }
});

/* =========================================================
   DASHBOARD DATA
   ========================================================= */

app.get("/api/dashboard", async (_req, res) => {
  try {
    const config = await readPrintersFile();
    const fiwareResult = await fetchFiwarePrintersSafe();

    return res.json({
      ok: true,
      printers: fiwareResult.data || [],
      configPrinters: config.printers || [],
      configLastUpdated: config.last_updated,
      warnings: {
        printersError: fiwareResult.error,
      },
    });
  } catch (err) {
    console.error("GET /api/dashboard failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Dashboard request failed",
      details: err.message,
    });
  }
});

/* =========================================================
   MANUAL MQTT VALIDATION ROUTE
   ========================================================= */

app.post("/api/validate-printer-access", async (req, res) => {
  try {
    const body = req.body || {};

    const printer = sanitizePrinter({
      id: body.id || "manual-validation",
      name: body.name || "Manual validation",
      ip: body.ip,
      access_code: body.access_code,
      serial: body.serial,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    });

    const validationErrors = validatePrinter(printer);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Validation failed",
        details: validationErrors.join("; "),
      });
    }

    const validation = await validateBambuMqttAccess(printer);

    return res.status(validation.ok ? 200 : 400).json({
      ok: validation.ok,
      validation,
    });
  } catch (err) {
    console.error("POST /api/validate-printer-access failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Manual MQTT validation failed",
      details: err.message,
    });
  }
});

/* =========================================================
   PRINTER CONFIG ROUTES
   ========================================================= */

app.get("/api/printer-config", getPrinterConfigHandler);
app.put("/api/printer-config", putPrinterConfigHandler);
app.patch("/api/printer-config/:id", patchPrinterConfigHandler);

app.get("/api/settings/printers", getPrinterConfigHandler);
app.put("/api/settings/printers", putPrinterConfigHandler);

/* =========================================================
   BRIDGE CONTROL
   ========================================================= */

app.post("/api/restart-bridge", async (_req, res) => {
  try {
    const result = await restartBridgeService();
    return res.json(result);
  } catch (err) {
    console.error("POST /api/restart-bridge failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Failed to restart bridge",
      details: err.message,
    });
  }
});

app.get("/api/bridge-status", async (_req, res) => {
  try {
    const status = await getBridgeStatus();
    return res.json(status);
  } catch (err) {
    console.error("GET /api/bridge-status failed:", err);

    return res.status(500).json({
      ok: false,
      error: "Failed to get bridge status",
      details: err.message,
    });
  }
});

/* =========================================================
   PEPPI REMOVED FROM THIS BACKEND
   ========================================================= */

app.get("/api/peppi", (_req, res) => {
  return res.status(410).json({
    ok: false,
    error: "Peppi endpoint moved",
    message:
      "Peppi booking data is now served by the separate Peppi backend on port 5050.",
    new_backend_example: "http://localhost:5050/api/peppi",
  });
});

/* =========================================================
   HEALTH
   ========================================================= */

app.get("/api/health", async (_req, res) => {
  const bridgeStatus = await getBridgeStatus().catch(() => null);

  return res.json({
    ok: true,
    service: "printer-dashboard-backend",
    role: "printer_gateway_only",
    port: PORT,
    platform: process.platform,
    printers_file: PRINTERS_FILE,
    fiware_entity_url: FIWARE_ENTITY_URL,
    bridge_service: BRIDGE_SERVICE_NAME,
    auto_restart_on_save: AUTO_RESTART_BRIDGE_ON_SAVE,
    validate_mqtt_on_save: VALIDATE_MQTT_ON_SAVE,
    mqtt_validator_script: MQTT_VALIDATOR_SCRIPT,
    mqtt_validator_python: MQTT_VALIDATOR_PYTHON,
    mqtt_validation_timeout_seconds: MQTT_VALIDATION_TIMEOUT_SECONDS,
    bridge_status: bridgeStatus,
    peppi_removed: true,
    timestamp: new Date().toISOString(),
  });
});

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Printer backend running on port ${PORT}`);
  console.log(`📄 Using printers file: ${PRINTERS_FILE}`);
  console.log(`🔁 Bridge service: ${BRIDGE_SERVICE_NAME}`);
  console.log(`🔁 Auto restart on save: ${AUTO_RESTART_BRIDGE_ON_SAVE}`);
  console.log(`🔐 Validate MQTT on save: ${VALIDATE_MQTT_ON_SAVE}`);
  console.log(`🐍 MQTT validator python: ${MQTT_VALIDATOR_PYTHON}`);
  console.log(`🐍 MQTT validator script: ${MQTT_VALIDATOR_SCRIPT}`);
  console.log("📅 Peppi booking logic has been moved to separate backend");
});
