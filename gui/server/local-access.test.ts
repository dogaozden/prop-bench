import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { request } from "node:http";
import { assertLocalHost, localAccess } from "./local-access";

test("owner server refuses public binds",()=>{
  for(const host of ["localhost","127.0.0.1","::1"])assert.doesNotThrow(()=>assertLocalHost(host));
  for(const host of ["0.0.0.0","::","example.com"])assert.throws(()=>assertLocalHost(host),/loopback/);
});

test("real HTTP boundary admits owner UI and blocks public-origin mutations and DNS rebinding",async()=>{
  const app=express();let mutations=0;
  app.use(localAccess(3001));app.post("/run",(_req,res)=>{mutations++;res.json({ok:true});});
  const server=app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const addr=server.address();assert.ok(addr&&typeof addr!=="string");
  const endpoint=`http://127.0.0.1:${addr.port}/run`;
  const post=(headers:Record<string,string>)=>new Promise<{status:number;origin: string|undefined}>((resolve,reject)=>{
    const req=request(endpoint,{method:"POST",headers},res=>{res.resume();res.on("end",()=>resolve({status:res.statusCode!,origin:res.headers["access-control-allow-origin"] as string|undefined}));});
    req.on("error",reject);req.end();
  });
  try {
    const rejectedHeaders: Record<string,string>[] = [
      {host:"localhost:3001",origin:"https://attacker.example"},
      {host:"attacker.example:3001",origin:"http://localhost:3000"},
      {host:"localhost:3001",origin:"null"},
      {host:"localhost:3001","sec-fetch-site":"cross-site"},
      {host:"localhost:3001",origin:"http://localhost:9999"},
    ];
    for(const headers of rejectedHeaders)assert.equal((await post(headers)).status,403);
    assert.equal(mutations,0);
    const valid=await post({host:"localhost:3001",origin:"http://localhost:3000"});
    assert.equal(valid.status,200);assert.equal(valid.origin,"http://localhost:3000");
    assert.equal((await post({host:"127.0.0.1:3001"})).status,200);
    assert.equal(mutations,2);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
