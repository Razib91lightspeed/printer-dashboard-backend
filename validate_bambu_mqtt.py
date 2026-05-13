#!/usr/bin/env python3

import argparse
import json
import ssl
import sys
import time
import uuid

import paho.mqtt.client as mqtt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--access-code", required=True)
    parser.add_argument("--timeout", type=float, default=6.0)
    args = parser.parse_args()

    result = {
        "ok": False,
        "reason": "UNKNOWN",
        "message": "",
        "ip": args.ip,
        "serial": args.serial,
        "received_message": False,
        "connect_rc": None,
    }

    connected = False
    received_message = False
    failed_reason = None

    topic = f"device/{args.serial}/report"
    client_id = f"fieldlab-validate-{uuid.uuid4().hex[:10]}"

    def finish_and_print():
        print(json.dumps(result))
        sys.stdout.flush()

    def on_connect(client, userdata, flags, rc):
        nonlocal connected, failed_reason

        result["connect_rc"] = rc

        if rc == 0:
            connected = True
            result["reason"] = "CONNECTED"
            result["message"] = "MQTT connection accepted."
            client.subscribe(topic)
            return

        connected = False

        if rc in (4, 5):
            failed_reason = "ACCESS_CODE_INVALID"
            result["reason"] = "ACCESS_CODE_INVALID"
            result["message"] = (
                "MQTT authentication failed. The access code is probably invalid."
            )
        else:
            failed_reason = f"MQTT_CONNECT_FAILED_RC_{rc}"
            result["reason"] = failed_reason
            result["message"] = f"MQTT connection failed with return code {rc}."

    def on_message(client, userdata, msg):
        nonlocal received_message

        received_message = True
        result["received_message"] = True
        result["ok"] = True
        result["reason"] = "MQTT_VALID"
        result["message"] = "Access code is valid. Fresh MQTT data was received."

        client.disconnect()

    def on_disconnect(client, userdata, rc):
        pass

    try:
        client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)
        client.username_pw_set("bblp", args.access_code)

        client.tls_set(cert_reqs=ssl.CERT_NONE)
        client.tls_insecure_set(True)

        client.on_connect = on_connect
        client.on_message = on_message
        client.on_disconnect = on_disconnect

        client.connect(args.ip, 8883, keepalive=10)
        client.loop_start()

        start = time.time()

        while time.time() - start < args.timeout:
            if failed_reason:
                break

            if received_message:
                break

            time.sleep(0.1)

        client.loop_stop()

        try:
            client.disconnect()
        except Exception:
            pass

        if result["ok"]:
            finish_and_print()
            return 0

        if failed_reason:
            finish_and_print()
            return 2

        if connected and not received_message:
            result["ok"] = True
            result["reason"] = "MQTT_CONNECTED_NO_MESSAGE_YET"
            result["message"] = (
                "MQTT login succeeded, but no report message arrived during the short validation window. "
                "The access code is accepted."
            )
            finish_and_print()
            return 0

        result["ok"] = False
        result["reason"] = "MQTT_TIMEOUT"
        result["message"] = (
            "Could not verify MQTT connection before timeout. "
            "The printer may be unreachable, offline, or the access code may be wrong."
        )
        finish_and_print()
        return 3

    except TimeoutError:
        result["ok"] = False
        result["reason"] = "PRINTER_UNREACHABLE"
        result["message"] = "Connection timed out. Printer is unreachable."
        finish_and_print()
        return 4

    except ConnectionRefusedError:
        result["ok"] = False
        result["reason"] = "CONNECTION_REFUSED"
        result["message"] = "Printer refused the MQTT connection."
        finish_and_print()
        return 5

    except OSError as exc:
        result["ok"] = False
        result["reason"] = "NETWORK_ERROR"
        result["message"] = f"Network error while connecting to printer: {exc}"
        finish_and_print()
        return 6

    except Exception as exc:
        result["ok"] = False
        result["reason"] = "VALIDATION_ERROR"
        result["message"] = f"Unexpected validation error: {exc}"
        finish_and_print()
        return 7


if __name__ == "__main__":
    raise SystemExit(main())
