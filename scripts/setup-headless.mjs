import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dsh=process.env.DSH_HOME??path.join(os.homedir(),'.dsh');
const desktop=path.join(dsh,'profiles/desktop');
const target=path.join(dsh,'profiles/dots-control');
const desktopPackage=JSON.parse(fs.readFileSync(path.join(desktop,'package.json'),'utf8'));
const linked=desktopPackage.dependencies?.['dsh-claude-codex-team'];
if(linked!==`link:${root}`)throw Error('Install this plugin into the desktop profile first; see README.md');
const catalog=JSON.parse(fs.readFileSync(path.join(dsh,'plugins/subscriptions/models.json'),'utf8'));
const allowedModels=['codex','claude'].flatMap(provider=>(catalog[provider]?.models??[]).map(m=>({provider,model:m.id})));
if(!allowedModels.length)throw Error('No subscription models found. Connect Claude or ChatGPT in DSH first.');
if(fs.existsSync(target))throw Error(`Profile already exists: ${target}. Keep the existing profile or move it aside before setup.`);
fs.mkdirSync(target,{recursive:true});
const profile={name:'dsh-profile-dots-control',private:true,dependencies:{...desktopPackage.dependencies},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','dsh-plugin-subscriptions','dsh-claude-codex-team']}}};
fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(profile,null,2)+'\n');
fs.writeFileSync(path.join(target,'cordis.yml'),'[]\n');
const parent={provider:'claude',model:'claude-sonnet-5-5',reasoningEffort:'high'};
const patch=[
 {id:'agent-default-model',config:parent},
 {id:'llm-subscriptions',config:{providers:['codex','claude']}},
 {id:'tool-subagent',disabled:true},{id:'tool-subagent-fork',disabled:true},{id:'tool-workflow',disabled:true},
 {id:'system-prompt',config:{personaSuffix:'Your working directory is {{cwd}}.',personaPrefix:'You coordinate an adaptive agent team. Read team_settings before delegating. Use worker(run_in_background:true) for independent tasks and job_output to collect each result. Choose any advertised child model per task. In auto mode choose useful concurrency up to max_parallel; in manual mode use the requested count if independent tasks exist. Do not raise saved limits. Review diffs and meaningful tests. Respect repository instructions. Reply in the user’s language.'}},
 {insert:[{id:'subagent-model-selection-settings',name:'@deepseek-ai/dsh-tool-subagent/model-selection-settings',config:{enabled:true,allowedModels}},{id:'adaptive-headless-tools',name:'dsh-claude-codex-team/headless'}]},
 {id:'preset-claude-codex-team',disabled:true}
];
fs.writeFileSync(path.join(target,'cordis.patch.yml'),JSON.stringify(patch,null,2)+'\n');
fs.symlinkSync(path.join(desktop,'node_modules'),path.join(target,'node_modules'),'dir');
console.log(`Created ${target}. Set the parent model in the desktop Agent team settings, then run node skills/dsh-control/scripts/control.mjs.`);
