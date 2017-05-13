const nativePort = chrome.runtime.connectNative('org.urish.web_bluetooth.server');
const debugPrints = false;

let requestId = 0;
let requests = {};
async function nativeRequest(cmd, params) {
    return new Promise((resolve, reject) => {
        requests[requestId] = { resolve, reject };
        const msg = Object.assign(params || {}, {
            cmd,
            _id: requestId++
        });
        if (debugPrints) {
            console.log('Sent native message:', msg);
        }
        nativePort.postMessage(msg);
    });
}

const subscriptions = {};
nativePort.onMessage.addListener((msg) => {
    if (debugPrints) {
        console.log('Received native message:', msg);
    }
    if (msg._type === 'response' && requests[msg._id]) {
        const { reject, resolve } = requests[msg._id];
        if (msg.error) {
            reject(msg.error);
        } else {
            resolve(msg.result);
        }
        delete requests[msg._id];
    }
    if (msg._type === 'valueChangedNotification') {
        const subscriber = subscriptions[msg.subscriptionId];
        if (subscriber) {
            chrome.tabs.sendMessage(subscriber.id, msg);
        }
    }
});

nativePort.onDisconnect.addListener(() => {
    console.log("Disconnected!", chrome.runtime.lastError.message);
});

function leftPad(s, count, pad) {
    while (s.length < count) {
        s = pad + s;
    }
    return s;
}

function normalizeUuid(uuid) {
    const origUuid = uuid;
    // TODO: complete this list
    var standardUuids = {
        // characteristics
        battery_level: 0x2a19,

        // services
        heart_rate: 0x180d,
        battery_service: 0x180f,
        cycling_power: 0x1818,
    }
    if (standardUuids[uuid]) {
        uuid = standardUuids[uuid];
    }
    if (typeof uuid === 'string' && /^(0x)?[0-9a-f]{1,8}$/.test(uuid)) {
        uuid = parseInt(uuid, 16);
    }
    // 16 or 32 bit GUID
    if (typeof uuid === 'number' && uuid > 0) {
        return `${leftPad(uuid.toString(16), 8, '0')}-0000-1000-8000-00805f9b34fb`;
    }
    if (/^{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}?$/.test(uuid)) {
        return uuid.replace('{', '').replace('}', '').toLowerCase();
    }
    throw new Error(`Invalid UUID format: ${origUuid}`);
}

function windowsUuid(uuid) {
    return '{' + normalizeUuid(uuid) + '}';
}

function matchDeviceFilter(filter, device) {
    if (filter.services) {
        const deviceServices = device.serviceUuids.map(normalizeUuid);
        if (!filter.services.map(normalizeUuid).every(uuid => deviceServices.includes(uuid))) {
            return false;
        }
    }
    if (filter.name && filter.name !== device.localName) {
        return false;
    }
    if (filter.namePrefix && device.localName.indexOf(filter.namePrefix) !== 0) {
        return false;
    }
    return true;
}

let scanning = false;
async function requestDevice(sender, options) {
    if (!options.filters) {
        // TODO better filters validation, proper error message
        throw new Error('Filters must be provided');
    }

    let deviceFoundCallback = null;
    nativePort.onMessage.addListener(msg => {
        if (msg._type === 'scanResult' && deviceFoundCallback) {
            if (options.acceptAllDevices ||
                options.filters.some(filter => matchDeviceFilter(filter, msg))) {
                nativeRequest('stopScan');
                deviceFoundCallback(msg);
            }
        }
    });
    if (!scanning) {
        await nativeRequest('scan');
    }
    const device = await new Promise(resolve => {
        deviceFoundCallback = resolve;
    });

    return {
        address: device.bluetoothAddress,
        __rssi: device.rssi,
        name: device.localName
    };
}

async function gattConnect(sender, address) {
    return await nativeRequest('connect', { address: address.replace(/:/g, '') });
}

async function gattDisconnect(sender, gattId) {
    return await nativeRequest('disconnect', { device: gattId });
}

async function getPrimaryService(sender, gattId, service) {
    return (await getPrimaryServices(sender, gattId, service))[0];
}

async function getPrimaryServices(sender, gattId, service) {
    let options = { device: gattId };
    if (service) {
        options.service = windowsUuid(service);
    }
    return await nativeRequest('services', options);
}

async function getCharacteristic(sender, gattId, service, characteristic) {
    const char = (await getCharacteristics(sender, gattId, service, characteristic)).find(x => true);
    if (!char) {
        throw new Error(`Characteristic ${characteristic} not found`);
    }
    return char;
}

const charCache = {};
async function getCharacteristics(sender, gattId, service, characteristic) {
    const key = `${gattId}/${service}`;
    if (!charCache[key]) {
        charCache[key] = await nativeRequest('characteristics', { device: gattId, service: windowsUuid(service) });
    }
    const result = charCache[key];
    if (characteristic) {
        return result.filter(c => normalizeUuid(c.uuid) == normalizeUuid(characteristic))
    } else {
        return result;
    }
}

async function readValue(sender, gattId, service, characteristic) {
    return await nativeRequest('read', {
        device: gattId,
        service: windowsUuid(service),
        characteristic: windowsUuid(characteristic)
    });
}

async function writeValue(sender, gattId, service, characteristic, value) {
    if (!(value instanceof Array) || !value.every(item => typeof item === 'number')) {
        throw new Error('Invalid argument: value');
    }

    return await nativeRequest('write', {
        device: gattId,
        service: windowsUuid(service),
        characteristic: windowsUuid(characteristic),
        value
    });
}

async function startNotifications(sender, gattId, service, characteristic) {
    const subscriptionId = await nativeRequest('subscribe', {
        device: gattId,
        service: windowsUuid(service),
        characteristic: windowsUuid(characteristic)
    });

    subscriptions[subscriptionId] = sender.tab;
    return subscriptionId;
}

const exportedMethods = {
    requestDevice,
    gattConnect,
    gattDisconnect,
    getPrimaryService,
    getPrimaryServices,
    getCharacteristic,
    getCharacteristics,
    readValue,
    writeValue,
    startNotifications
};

chrome.runtime.onMessage.addListener(
    function (request, sender, sendResponse) {
        if (!request.command) {
            sendResponse({ error: 'Missing `command`' });
        }
        if (!(request.args instanceof Array)) {
            sendResponse({ error: '`args` must be an array' });
        }
        const fn = exportedMethods[request.command];
        if (fn) {
            fn(sender, ...request.args)
                .then(result => sendResponse({ result }))
                .catch(error => sendResponse({ error: error.toString() }))
            return true;
        } else {
            sendResponse({ error: 'Unknown command: ' + request.command });
        }
    });

chrome.browserAction.onClicked.addListener(tab => {
    chrome.tabs.executeScript(tab.ib, {
        file: 'content.js'
    });
});

nativeRequest('ping').then(() => {
    console.log('Connected to server');
});
