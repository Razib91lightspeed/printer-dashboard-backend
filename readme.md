# 🖨️ Printer Dashboard Backend

A Node.js / Express gateway designed to bridge communication between **Bambu Lab 3D Printers**, **FIWARE Orion Context Broker**, and a frontend dashboard. This service handles printer configuration, MQTT validation, and serves as a telemetry proxy.

## 🚀 Overview

This backend manages:
- **Printer Metadata**: CRUD operations on `printers.json`.
- **MQTT Validation**: Interacts with Python scripts to verify printer access codes.
- **FIWARE Integration**: Proxies telemetry data from an NGSI-LD compatible broker.
- **System Control**: Restarts the `bambu-bridge` service on Linux systems.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js
- **Logic**: Python 3 (for MQTT validation)[cite: 1]
- **Data Format**: NGSI-LD (FIWARE)[cite: 1]

---

## 📡 API Reference

### 1. Printer Configuration
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/printer-config` | Retrieve the full `printers.json` configuration[cite: 1]. |
| `PUT` | `/api/printer-config` | Replace the entire printer list (includes auto-validation)[cite: 1]. |
| `PATCH` | `/api/printer-config/:id` | Update specific printer fields (IP, access code, etc.)[cite: 1]. |

### 2. Live Data & Status
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/printers` | Fetch live printer telemetry from FIWARE[cite: 1]. |
| `GET` | `/api/dashboard` | Aggregated view of config + live data[cite: 1]. |
| `GET` | `/api/bridge-status` | Check if the systemd bridge service is active[cite: 1]. |

### 3. System Actions
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/restart-bridge` | Triggers `sudo systemctl restart` (Linux only)[cite: 1]. |
| `POST` | `/api/validate-printer-access` | Manually test a printer's MQTT credentials[cite: 1]. |

---

## 📅 Peppi Booking API (Legacy/Redirect)

> [!IMPORTANT]
> **Peppi integration has been decoupled.** The booking logic no longer resides in this repository[cite: 1]. To maintain compatibility with existing frontends, the endpoint remains but acts as a pointer to the new microservice[cite: 1].

### `GET /api/peppi`
Returns status code `410 Gone`[cite: 1].

**Response Example:**
```json
{
  "ok": false,
  "error": "Peppi endpoint moved",
  "message": "Peppi booking data is now served by the separate Peppi backend on port 5050.",
  "new_backend_example": "http://localhost:5050/api/peppi"
}
```

**New Service Location:**
- **Standard Port**: 5050[cite: 1]
- **Primary Endpoint**: `http://<server-ip>:5050/api/peppi`[cite: 1]

---

## ⚙️ Configuration

The application uses environment variables or default local paths. On a Mac (development), it defaults to local data. On the Raspberry Pi (production), it targets absolute paths.[cite: 1]

| Variable | Default (Pi Path) | Description |
| :--- | :--- | :--- |
| `PORT` | `4000` | Server listening port.[cite: 1] |
| `PRINTERS_FILE` | `/home/fieldlab/Desktop/bambu-fiware/printers.json` | Path to the config file.[cite: 1] |
| `MQTT_VALIDATOR_PYTHON` | `.../venv/bin/python3` | Path to the Python executable.[cite: 1] |

## 📦 Installation

1. **Clone and Install Node modules:**
   ```bash
   npm install
```

2. **Python Dependencies (for MQTT validation):**
 ```bash
pip install paho-mqtt
```
3. **Running the app:**
   ```bash
   # Development
   node index.js
   
   # Production (on Pi)
   sudo systemctl start printer-dashboard
```

# License
ISC
