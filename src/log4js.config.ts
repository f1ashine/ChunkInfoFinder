import log4js from 'log4js';

log4js.configure({
    appenders: {
        out: {
            type: 'console',
            layout: {
                type: 'pattern',
                pattern: '[%d{hh:mm:ss}] %[%m%]'
            }
        }
    },
    categories: {
        default: { appenders: ['out'], level: 'info' }
    }
});

export default log4js;
