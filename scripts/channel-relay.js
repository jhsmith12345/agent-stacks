// An untrusted message relay for channel matches. Usage: node scripts/channel-relay.js [PORT] [HOST]
import {startRelay} from '../src/channel/relay.js';
const relay=await startRelay({port:Number(process.argv[2]??0),host:process.argv[3]??'127.0.0.1'});
console.log(JSON.stringify({relay:relay.url}));
