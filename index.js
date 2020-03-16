/*jslint node: true */
'use strict';

const Slack = require('node-slack');
const moment = require('moment');

const cache = {};
const DEBOUNCE_TIME = process.env.WATCHMEN_SLACK_DEBOUNCE && parseInt(process.env.WATCHMEN_SLACK_DEBOUNCE, 10) || 30000; // 30s
const SUPPORTED_EVENTS = ['latency-warning', 'new-outage', 'service-back', 'current-outage', 'service-error', 'service-ok'];
const ENV_NOTIFICATIONS  = process.env.WATCHMEN_SLACK_NOTIFICATION_EVENTS || SUPPORTED_EVENTS;

const debounce = (fn, time) => {
  let timeout;

  return function() {
    const functionCall = () => fn.apply(this, arguments);

    clearTimeout(timeout);
    timeout = setTimeout(functionCall, time);
  }
}

const friendlyNames = {
    'latency-warning': 'Latency Warning',
    'new-outage':      'New Outages',
    'current-outage':  'Current Outage',
    'service-back':    'Services are back',
    'service-error':   'Service Error',
    'service-ok':      'Service OK'
};

const slack = new Slack(process.env.WATCHMEN_SLACK_NOTIFICATION_URL);
const defaultOptions = {
    channel: '#general',
    username: 'Watchmen',
    icon_emoji: ':mega:'
};

console.log(`Slack notifications are turned on for the following events: ${ENV_NOTIFICATIONS.join(', ')}`);

if ('WATCHMEN_SLACK_NOTIFICATION_CHANNEL' in process.env) {
    defaultOptions.channel = process.env.WATCHMEN_SLACK_NOTIFICATION_CHANNEL;
}

if ('WATCHMEN_SLACK_NOTIFICATION_USERNAME' in process.env) {
    defaultOptions.username = process.env.WATCHMEN_SLACK_NOTIFICATION_USERNAME;
}

if ('WATCHMEN_SLACK_NOTIFICATION_ICON_EMOJI' in process.env) {
    defaultOptions.icon_emoji = process.env.WATCHMEN_SLACK_NOTIFICATION_ICON_EMOJI;
}

const debouncedProcessEvents = debounce(processOutageEvents, DEBOUNCE_TIME);

let currentOutages = {};
let currentBacks = {};

const specialHandlers = {
    'new-outage': (service, data) => {
        currentOutages[service.id] = currentOutages[service.id] || {service, data};

        if(currentBacks[service.id]) { // if the service was back but it is outaged in the meantime
            currentBacks[service.id] = null;
            delete currentBacks[service.id];
        }

        debouncedProcessEvents();
    },
    'service-back': (service, data) => {
        if(currentOutages[service.id]) { // if the service was outaged but it is back in the meantime
            currentOutages[service.id] = null;
            delete currentOutages[service.id];
        }

        currentBacks[service.id] = currentBacks[service.id] || {service, data};

        debouncedProcessEvents();
    }
};

function handleEvent(eventName) {
    return function(service, data) {
        if (ENV_NOTIFICATIONS.indexOf(eventName) === -1) {
            return;
        }

        if(specialHandlers[eventName]) return specialHandlers[eventName](service, data);

        const text = `[${friendlyNames[eventName]}] on ${service.name} ${service.url}`;

        slack.send(Object.assign({}, defaultOptions, { text }));
    };
}

const colors = {
    'new-outage': '#FA4F37',
    'service-back': '#79C580'
}

const notificationText = {
    'new-outage': (service, data) => `:server: ${service.name} (${service.url}) - ${moment(data.timestamp).fromNow()}`,
    'service-back': (service, lastOutage = {}) => {
        const duration = moment.duration(Date.now() - lastOutage.timestamp);

        return `:server: ${service.name} (Down for ${duration.humanize()})`}
}

function sendSlackNotification(event, services) {
    const outagesNotifications = services.map(({service, data}) => ({
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": notificationText[event](service, data) || ''
        },
        "accessory": {
            "type": "button",
            "text": {
                "type": "plain_text",
                "text": "View",
                "emoji": true
            },
            "url": `${process.env.WATCHMEN_BASE_URL}/services/${service.id}/view`,
            "value": "view_alternate_1"
        }
    }));

    const statsBlock = [];

    if(Object.keys(currentOutages).length && event === 'service-back') {
        statsBlock.push({
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": Object.keys(currentOutages).length > 1 ? `Currently there are still ${Object.keys(currentOutages).length} outages.` : `Currently there is still ${Object.keys(currentOutages).length} outage.`
            }})
    }

    const blocks = [{
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": `*${friendlyNames[event]}*`
        }
    },
    ...outagesNotifications,
    ...statsBlock
    ];

    var options = {
        "text": "\n",
        "attachments": [
            {
                "color": colors[event],
                "blocks": blocks
            }
        ]
    }

    return slack.send(options);
}

async function processOutageEvents() {
    const outages = Object.keys(currentOutages).map(k => currentOutages[k]);
    const backs = Object.keys(currentBacks).map(k => currentBacks[k]);

    if(outages.length) {
        sendSlackNotification('new-outage', outages);
        currentOutages = {};
    }

    if(backs.length) {
        sendSlackNotification('service-back', backs);
        currentBacks = {};
    }

}

function SlackPlugin(watchmen) {
    watchmen.on('latency-warning', handleEvent('latency-warning'));
    watchmen.on('new-outage',      handleEvent('new-outage'));
    watchmen.on('service-back',    handleEvent('service-back'));
    watchmen.on('current-outage',  handleEvent('current-outage'));
    watchmen.on('service-error',   handleEvent('service-error'));
    watchmen.on('service-ok',      handleEvent('service-ok'));
}

const outage = handleEvent('new-outage');
const back = handleEvent('service-back');

exports = module.exports = SlackPlugin;
