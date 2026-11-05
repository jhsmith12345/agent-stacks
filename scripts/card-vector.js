// Known scalar fixtures for SBF integration tests, never agent private-key storage.
import { proveDLEQ, encodeDLEQ } from '../src/mental-poker/proofs.js';
import { scalarHex } from '../src/mental-poker/group.js';
const [context,secret,base]=process.argv.slice(2);
const p=proveDLEQ(scalarHex(BigInt(secret)),base,context);
console.log(encodeDLEQ(context,p.publicKey,base,p.share,p.proof).toString('hex'));
