import express from "express";
import client from "prom-client";
import axios from "axios";
import mdns from "mdns-js";
import _ from "lodash";

// Configuration
const PORT = 9769;
const DISCOVERY_INTERVAL = 60000; // rediscover every 60 seconds

const register = new client.Registry();

type Gauges = {
    power: client.Gauge<string>;
    current: client.Gauge<string>;
    voltage: client.Gauge<string>;
    temp: client.Gauge<string>;
};

type PlugInfo = {
    name: string;
    metricPrefix: string;
    gauges: Gauges;
    ip: string;
    mdnsName: string;
};

const plugInfo: Record<string, PlugInfo> = {};

register.setDefaultLabels({
    exporter: "shelly-plug-s",
});

client.collectDefaultMetrics({ register });

// mDNS Discovery
function discoverShellyDevices() {
    const found: Record<string, string> = {}; // mdnsName -> ip

    // const browser = mdns.createBrowser("_http._tcp.local");
    const browser = mdns.createBrowser("_shelly._tcp");
    browser.on("ready", () => browser.discover());
    browser.on("update", data => {
        // console.log('Discovered mDNS data:', data);
        if (
            data.fullname &&
            typeof data.fullname === "string" &&
            data.fullname.startsWith("shellyplugsg3-")
        ) {
            const mdnsName = data.fullname.replace(/\._shelly\._tcp\.local$/, "");
            const ip = data.addresses.find(addr => addr.match(/^\d+\.\d+\.\d+\.\d+$/));
            if (ip && !plugInfo[mdnsName]) {
                found[mdnsName] = ip;
                console.log('shelly plug found:', mdnsName, 'at', ip);
                setupPlug(mdnsName, ip);
            }
        }
    });

    // Clean up browser after a while
    setTimeout(() => browser.stop(), 30000);
}

async function fetchPlugName(ip: string, mdnsName: string): Promise<{ name: string; metricPrefix: string }> {
    try {
        const url = `http://${ip}/rpc/Sys.GetConfig`;
        const { data } = await axios.get(url, { timeout: 2000 });

        let name: string | null = null;
        if (data.device && typeof data.device.name === "string" && data.device.name.length > 0) {
            name = data.device.name;
        } else if (
            data.cfg &&
            data.cfg.device &&
            typeof data.cfg.device.mac === "string" &&
            data.cfg.device.mac.length > 0
        ) {
            name = data.cfg.device.mac;
        }

        if (!name) {
            name = mdnsName;
        }

        const metricPrefix = `shelly_${_.snakeCase(name)}`;
        return { name, metricPrefix };
    } catch (err) {
        console.error(`Error fetching name for ${ip}:`, (err as Error).message);
        const fallback = `shelly_${mdnsName}`;
        return { name: fallback, metricPrefix: fallback };
    }
}

async function setupPlug(mdnsName: string, ip: string): Promise<void> {
    if (plugInfo[mdnsName]) return;

    const { name, metricPrefix } = await fetchPlugName(ip, mdnsName);

    const gauges: Gauges = {
        power: new client.Gauge({
            name: `${metricPrefix}_power`,
            help: `Power usage in watts for ${name}`,
            labelNames: ["mdnsName"],
        }),
        current: new client.Gauge({
            name: `${metricPrefix}_current`,
            help: `Current in amps for ${name}`,
            labelNames: ["mdnsName"],
        }),
        voltage: new client.Gauge({
            name: `${metricPrefix}_voltage`,
            help: `Voltage in volts for ${name}`,
            labelNames: ["mdnsName"],
        }),
        temp: new client.Gauge({
            name: `${metricPrefix}_temp`,
            help: `Plug temperature in Celsius for ${name}`,
            labelNames: ["mdnsName"],
        }),
    };

    plugInfo[mdnsName] = { name, metricPrefix, gauges, ip, mdnsName };

    register.registerMetric(gauges.power);
    register.registerMetric(gauges.current);
    register.registerMetric(gauges.voltage);
    register.registerMetric(gauges.temp);

    console.log(`Registered Shelly Plug S: ${name} at ${ip} (mDNS: ${mdnsName})`);
}

async function updateMetricsForPlug(plug: PlugInfo): Promise<void> {
    const { name, gauges, ip, mdnsName } = plug;
    const url = `http://${ip}/rpc/Switch.GetStatus?id=0`;
    try {
        const { data } = await axios.get(url, { timeout: 2000 });
        gauges.power.set({mdnsName}, data.apower ?? 0);
        gauges.current.set({mdnsName}, data.current ?? 0);
        gauges.voltage.set({mdnsName} ,data.voltage ?? 0);
        if (data.temperature && typeof data.temperature.tC === "number") {
            gauges.temp.set({mdnsName}, data.temperature.tC);
        } else {
            gauges.temp.set({mdnsName}, 0);
        }
    } catch (err) {
        gauges.power.set({mdnsName}, NaN);
        gauges.current.set({mdnsName}, NaN);
        gauges.voltage.set({mdnsName}, NaN);
        gauges.temp.set({mdnsName}, NaN);
        console.error(`Error updating metrics for ${name} (${ip}):`, (err as Error).message);
    }
}

async function updateAllMetrics(): Promise<void> {
    await Promise.all(Object.values(plugInfo).map(updateMetricsForPlug));
}

// Periodically rediscover plugs
setInterval(() => {
    console.log("Running Shelly mDNS discovery...");
    discoverShellyDevices();
}, DISCOVERY_INTERVAL);

// Initial discovery before server start
(async () => {
    discoverShellyDevices();
    setInterval(updateAllMetrics, 5000);
    updateAllMetrics();

    const app = express();
    app.get("/metrics", async (_req, res) => {
        res.set("Content-Type", register.contentType);
        res.end(await register.metrics());
    });

    app.listen(PORT, () => {
        console.log(`Prometheus Shelly Plug exporter running at http://localhost:${PORT}/metrics`);
    });
})();