import {loadConfig} from "./config.js";
import {buildFinanceAdmin} from "./finance-admin.js";

const config=loadConfig();
// A release must explicitly provide a closed gate before joining the live DB.
if(!process.env.QUEFA_WORKER_GATE_FILE)throw new Error("finance_admin_requires_settlement_gate");
const app=await buildFinanceAdmin(config);
const shutdown=async()=>{await app.close();process.exit(0);};
process.on("SIGINT",shutdown);
process.on("SIGTERM",shutdown);
try{await app.listen({host:config.host,port:config.port});}
catch(error){app.log.error(error);process.exit(1);}
