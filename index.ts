import express, {Request, Response } from "express";
import client from "prom-client";
import axios from "axios";
import 'dotenv/config'
import mdns from "mdns-js";
import _ from "lodash";
import fs from "node:fs";
import * as process from "node:process";
import path from "node:path";
// import { parse as ms } from "@lukeed/ms";
import { parse, stringify } from 'yaml'

const LISTEN_PORT = process.env.LISTEN_PORT ? parseInt(process.env.LISTEN_PORT) : 9769;
// const DISCOVERY_INTERVAL = ms('60s');

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
    // gauges: Gauges;
    ip: string;
    mdnsName: string;
};

const plugInfo: Record<string, PlugInfo> = {};

register.setDefaultLabels({
    exporter: "shelly-plug-s",
});

client.collectDefaultMetrics({ register });

// mDNS Discovery
// function discoverShellyDevices() {
//     const found: Record<string, string> = {}; // mdnsName -> ip
//
//     // const browser = mdns.createBrowser("_http._tcp.local");
//     const browser = mdns.createBrowser("_shelly._tcp");
//     browser.on("ready", () => browser.discover());
//     browser.on("update", data => {
//         // console.log('Discovered mDNS data:', data);
//         if (
//             data.fullname &&
//             typeof data.fullname === "string" &&
//             data.fullname.startsWith("shellyplugsg3-")
//         ) {
//             const mdnsName = data.fullname.replace(/\._shelly\._tcp\.local$/, "");
//             const ip = data.addresses.find((addr: string) => addr.match(/^\d+\.\d+\.\d+\.\d+$/));
//             console.log('mDNS update:', mdnsName, 'at', ip);
//             if (ip && !plugInfo[mdnsName]) {
//                 found[mdnsName] = ip;
//                 console.log('shelly plug found:', mdnsName, 'at', ip);
//                 setupPlug(mdnsName, ip);
//             }
//         }
//     });
//
//     // Clean up browser after a while
//     setTimeout(() => browser.stop(), 30000);
// }

async function fetchPlugName(ip: string, mdnsName: string): Promise<{ name: string; metricPrefix: string }> {
    try {
        const urlC = `http://${ip}/rpc/Cloud.GetConfig`;
        const response = await axios.get(urlC, { timeout: 2000 });
        // console.log('Cloud config:', JSON.stringify(response.data, null, 2));

        const url = `http://${ip}/rpc/Sys.GetConfig`;
        const { data } = await axios.get(url, { timeout: 2000 });

        // console.log('Data', JSON.stringify(data, null, 2));

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

function registerMetrics() {

    const labelNames = ["mdnsName", "ip"];

    const gauges: Gauges = {
        power: new client.Gauge({
            name: `shelly_plug_power`,
            help: `Power usage in watts for plug`,
            labelNames
        }),
        current: new client.Gauge({
            name: `shelly_plug_current`,
            help: `Current in amps for plug`,
            labelNames
        }),
        voltage: new client.Gauge({
            name: `shelly_plug_voltage`,
            help: `Voltage in volts for plug`,
            labelNames
        }),
        temp: new client.Gauge({
            name: `shelly_plug_temp`,
            help: `Plug temperature in Celsius for plug`,
            labelNames
        }),
    };

    register.registerMetric(gauges.power);
    register.registerMetric(gauges.current);
    register.registerMetric(gauges.voltage);
    register.registerMetric(gauges.temp);
}

async function setupPlug(mdnsName: string, ip: string): Promise<void> {
    if (plugInfo[mdnsName]) return;

    const { name, metricPrefix } = await fetchPlugName(ip, mdnsName);

    plugInfo[mdnsName] = { name, metricPrefix, ip, mdnsName };

    console.log(`Registered Shelly Plug S: ${name} at ${ip} (mDNS: ${mdnsName})`);
}

async function updateMetricsForPlug(plug: PlugInfo): Promise<void> {
    const { name, ip, mdnsName } = plug;
    const powerGauge = register.getSingleMetric('shelly_plug_power') as client.Gauge;
    const currentGauge = register.getSingleMetric('shelly_plug_current') as client.Gauge;
    const voltageGauge = register.getSingleMetric('shelly_plug_voltage') as client.Gauge;
    const temperatureGauge = register.getSingleMetric('shelly_plug_temp') as client.Gauge;
    const url = `http://${ip}/rpc/Switch.GetStatus?id=0`;
    try {
        const { data } = await axios.get(url, { timeout: 2000 });
        // console.log(JSON.stringify(data, null, 2));
        powerGauge.set({mdnsName, ip}, data.apower ?? 0);
        currentGauge.set({mdnsName, ip}, data.current ?? 0);
        voltageGauge.set({mdnsName, ip} ,data.voltage ?? 0);
        if (data.temperature && typeof data.temperature.tC === "number") {
            temperatureGauge.set({mdnsName, ip}, data.temperature.tC);
        } else {
            temperatureGauge.set({mdnsName, ip}, 0);
        }
    } catch (err) {
        powerGauge.set({mdnsName, ip}, NaN);
        currentGauge.set({mdnsName, ip}, NaN);
        voltageGauge.set({mdnsName, ip}, NaN);
        temperatureGauge.set({mdnsName, ip}, NaN);
        console.error(`Error updating metrics for ${name} (${ip}):`, (err as Error).message);
    }
}

async function updateAllMetrics(): Promise<void> {
    await Promise.all(Object.values(plugInfo).map(updateMetricsForPlug));
}

// Periodically rediscover plugs
// setInterval(() => {
//     console.log("Running Shelly mDNS discovery...");
//     discoverShellyDevices();
// }, DISCOVERY_INTERVAL);

async function run () {
    registerMetrics();
    // discoverShellyDevices();
    setInterval(updateAllMetrics, 5000);
    updateAllMetrics();
    const configFile = process.env.CONFIG_FILE || '/config/config.yaml';
    console.log('Loading configuration from', configFile);
    const config = parse(fs.readFileSync(configFile, { encoding: "utf-8" }));
    for (const name of Object.keys(config.devices)) {
        setupPlug(name, config.devices[name]);
    }

    const app = express();
    app.get("/metrics", async (req: Request, res: Response) => {
        res.set("Content-Type", register.contentType);
        res.end(await register.metrics());
    });

    app.listen(LISTEN_PORT, () => {
        console.log(`Prometheus Shelly Plug exporter running at http://localhost:${LISTEN_PORT}/metrics`);
    });
}

run();