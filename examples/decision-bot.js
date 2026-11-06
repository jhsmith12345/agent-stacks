// A simple decision program, and a starting point for your own. See docs/connect-your-agent.md for what it's told.
//   node examples/decision-bot.js [STYLE] [--show always|never] [--delay MS] [--seed N] [--to LAMPORTS]
// STYLE: call (the default), raise, shove, fold, random, or plan, which raises to --to before the flop and then
// only checks and calls. For a real strategy, see examples/solver-bot.js.
import {createInterface} from 'node:readline';
import {setTimeout as pause} from 'node:timers/promises';
const option=(name,fallback=null)=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:fallback;};
const style=process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:'call';
const show=option('--show'),delay=Number(option('--delay',0)),planned=Number(option('--to',0));
let seed=Number(option('--seed',Date.now()))>>>0;
const random=()=>{seed=(seed+0x6d2b79f5)>>>0;let t=seed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
const passive=legal=>legal.check?{action:'check'}:{action:'call'};
const STYLES={
 call:({legal})=>passive(legal),
 raise:({legal})=>legal.raise?{action:'raise',to:legal.raise.min}:passive(legal),
 shove:({legal})=>legal.allIn?{action:'all-in'}:passive(legal),
 fold:({legal})=>legal.check?{action:'check'}:{action:'fold'},
 plan:({legal,street})=>street==='preflop'&&legal.raise&&planned>=legal.raise.min&&planned<=legal.raise.max?{action:'raise',to:planned}:passive(legal),
 random:({legal})=>{
  const roll=random();
  if(!legal.check&&roll<0.15)return {action:'fold'};
  if(legal.allIn&&roll<0.2)return {action:'all-in'};
  if(legal.raise&&roll<0.55)return {action:'raise',to:legal.raise.min+Math.floor(random()*Math.min(legal.raise.max-legal.raise.min+1,legal.raise.min*2))};
  return passive(legal);
 },
};
const decide=STYLES[style];
if(!decide)throw Error(`Unknown style ${style}`);
for await (const line of createInterface({input:process.stdin})){
 const question=JSON.parse(line);
 let reply=null;
 if(question.type==='bet')reply=decide(question);
 // By default, show a hand that wins or ties, and muck one that loses.
 else if(question.type==='show')reply={show:show==='always'?true:show==='never'?false:question.winning||question.tied};
 if(!reply)continue;
 if(delay)await pause(delay);
 console.log(JSON.stringify({id:question.id,...reply}));
}
