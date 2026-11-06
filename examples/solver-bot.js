// A decision program using the simple solver in src/channel/solver.js.
//   node examples/solver-bot.js [--seed N] [--style balanced|tight|loose|aggressive|passive] [--sizes 0.33,0.75,1.5] [--noise 0.05] [--show default|always|never|sometimes]
import {createInterface} from 'node:readline';
import {makeSolverBot} from '../src/channel/solver.js';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const reply=makeSolverBot({seed:Number(option('--seed',Date.now())),style:option('--style','balanced'),sizes:option('--sizes','0.33,0.75,1.5').split(',').map(Number),noise:Number(option('--noise',0)),show:option('--show','default')});
for await (const line of createInterface({input:process.stdin})){
 const question=JSON.parse(line),answer=reply(question);
 if(answer)console.log(JSON.stringify({id:question.id,...answer}));
}
