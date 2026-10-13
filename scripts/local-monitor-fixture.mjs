import { startServer } from '../backend/dist/app.js';

// Dedicated local verification fixture. Its provider rejects every write.
const port=Number(process.env.LOCAL_ERRORS_PORT ?? 3012);
process.env.SERVE_FRONTEND='true'; process.env.NODE_ENV='development';
delete process.env.PUBLIC_APP_URL;
process.env.CORS_ORIGIN=`http://127.0.0.1:${port}`;
const runtime=await startServer({
  port,databasePath:process.env.LOCAL_ERRORS_DATABASE ?? '.local/live-errors.sqlite',
  observer:{url:process.env.LOCAL_OBSERVER_URL ?? 'http://127.0.0.1:3013',allowLocal:true},
  commerce:{keyId:'rzp_test_local_monitor',keySecret:'local-fixture',providerTransport:async(method,path)=>{
    if(method!=='GET'||path!=='/orders')throw Error('Monitor fixture refuses payment writes');return {items:[]};
  }},
});
console.log(`Dedicated local monitor fixture listening on ${port}`);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await runtime.close();process.exit(0);});
