import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { db } from "../lib/db";
import { contributionLevel, CONTRIBUTION_LEVELS } from "../lib/contribution-levels";
import * as route from "../app/api/me/contributions/route";
assert.equal(process.env.DATABASE_URL, process.env.SCENARIOFORGE_TEST_DATABASE_URL);
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/scenarioforge_test_nextsteps_/);
type Actor = { id: string; token: string };
function req(actor: Actor | null, method = "GET", body?: unknown, query = "") {
  return new Request(`http://localhost/api/me/contributions${query}`, { method, headers: { Origin: "http://localhost", "Content-Type": "application/json", ...(actor ? { Cookie: `scenarioforge_session=${actor.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
test("level thresholds, level 7 and uncapped experience", () => {
  for (const rank of CONTRIBUTION_LEVELS) {
    assert.equal(contributionLevel(rank.threshold).level, rank.level);
    if (rank.threshold > 0) assert.equal(contributionLevel(rank.threshold - 1).level, rank.level - 1);
  }
  assert.equal(contributionLevel(9999).name, "项目狂人");
  assert.equal(contributionLevel(12345).experience, 12345);
  assert.equal(contributionLevel(9999).next, null);
  assert.equal(contributionLevel(9999).progress, 100);
  assert.equal(contributionLevel(50).progress, 50);
  assert.equal(contributionLevel(-30).experience, 0);
});
test("approved contributions are authorized, atomic, deduplicated and reversible", async () => {
  const actors: Actor[] = []; const projects: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const user = await db.user.create({ data: { username: `growth_${randomBytes(7).toString("hex")}`, passwordHash: "fixture-no-login" } });
      const token = randomBytes(32).toString("base64url");
      await db.authSession.create({ data: { userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3600000) } }); actors.push({ id: user.id, token });
    }
    const [a,b,c] = actors;
    const project = await db.project.create({ data: { name: "Contribution fixture", inviteCode: randomBytes(3).toString("hex"), members: { create: [{ userId:a.id,role:"owner" },{userId:b.id,role:"member"}] } } }); projects.push(project.id);
    const other = await db.project.create({ data: { name: "Other fixture", inviteCode: randomBytes(3).toString("hex"), members: { create: [{userId:a.id,role:"owner"}] } } }); projects.push(other.id);
    const pkg = await db.researchPackage.create({ data: { projectId: project.id, title: "SHARED_PHASE", goal: "fixture", status: "completed", summary: "完成阶段目标" } });
    const task = await db.agentSubtask.create({ data: { packageId:pkg.id,runId:randomBytes(8).toString("hex"),ordinal:1,objective:"SHARED_DELIVERY",context:"fixture",assigneeId:b.id,status:"review",result:"Deliverable" } });
    const confirm = {action:"confirm",projectId:project.id,kind:"task",targetId:task.id,note:"已逐项检查验收条件，交付内容符合项目要求。"};
    const milestone = {...confirm,kind:"milestone",targetId:pkg.id};
    const summary = async (actor:Actor) => (await (await route.GET(req(actor))).json()).summary;
    assert.equal((await route.GET(req(null))).status,401);
    assert.equal((await route.POST(req(b,"POST",confirm))).status,403);
    assert.equal((await route.POST(req(c,"POST",confirm))).status,403);
    assert.equal((await route.POST(req(a,"POST",{...confirm,points:9999}))).status,400);
    assert.equal((await route.POST(req(a,"POST",{...confirm,userId:c.id}))).status,400);
    assert.equal((await route.POST(req(a,"POST",{...confirm,note:"通过"}))).status,400);
    assert.equal((await route.POST(req(a,"POST",confirm))).status,409,"unsubmitted draft earns nothing");
    assert.equal((await route.POST(req(a,"POST",milestone))).status,409,"idle members get no milestone XP");
    await db.agentSubtask.update({where:{id:task.id},data:{status:"submitted"}});
    assert.equal((await route.POST(req(a,"POST",{...confirm,projectId:other.id}))).status,409);
    const simultaneous = await Promise.all([route.POST(req(a,"POST",confirm)),route.POST(req(a,"POST",confirm)),route.POST(req(a,"POST",confirm))]);
    assert.ok(simultaneous.every(response=>response.status===200));
    assert.equal((await summary(b)).experience,30); assert.equal((await summary(a)).experience,10);
    const timeline=await (await route.GET(req(b))).json();
    assert.ok(timeline.records[0].href.endsWith(`#personal-task-${task.id}`),"own delivery links to the personal task even without Git");
    assert.equal(await db.contributionRecord.count({where:{projectId:project.id}}),2);
    const knowledge = await db.projectKnowledgeItem.create({data:{projectId:project.id,title:"SHARED_KNOWLEDGE",question:"fixture",claim:"有效证据",sources:"[]",confidence:"high",status:"verified",originPackageId:pkg.id,originPackageTitle:pkg.title,originEvidenceId:"fixture-evidence",originEvidenceCode:"E1",createdBy:b.id}});
    const adoption={...confirm,kind:"knowledge",targetId:knowledge.id};
    assert.equal((await route.POST(req(a,"POST",adoption))).status,200);
    assert.equal((await route.POST(req(a,"POST",milestone))).status,200);
    assert.equal((await route.POST(req(a,"POST",milestone))).status,200);
    assert.equal((await summary(b)).experience,60); assert.equal((await summary(a)).experience,20,"review alone does not qualify for milestone");
    const managed=await (await route.GET(req(a,"GET",undefined,`?view=review&project=${project.id}`))).json();
    assert.ok(managed.candidates.some((row:{kind:string;recognized:boolean})=>row.kind==="task"&&row.recognized));
    assert.equal((await route.GET(req(b,"GET",undefined,`?view=review&project=${project.id}`))).status,403);
    assert.equal((await route.GET(req(b,"GET",undefined,`?project=${other.id}`))).status,404);
    const taskRecord=await db.contributionRecord.findUniqueOrThrow({where:{userId_sourceKey:{userId:b.id,sourceKey:`task:${task.id}`}}});
    const revoke={action:"revoke",projectId:project.id,recordId:taskRecord.id,note:"复核发现交付未满足要求，撤销认定。"};
    assert.equal((await route.POST(req(b,"POST",revoke))).status,403);
    assert.equal((await route.POST(req(a,"POST",{...revoke,projectId:other.id}))).status,404);
    assert.equal((await route.POST(req(a,"POST",revoke))).status,200);
    assert.equal((await summary(b)).experience,30); assert.equal((await summary(a)).experience,10);
    const knowledgeRecord=await db.contributionRecord.findUniqueOrThrow({where:{userId_sourceKey:{userId:b.id,sourceKey:`knowledge:${knowledge.id}`}}});
    assert.equal((await route.POST(req(a,"POST",{...revoke,recordId:knowledgeRecord.id}))).status,200);
    assert.equal((await summary(b)).experience,0,"last qualifying contribution revoked also retracts milestone"); assert.equal((await summary(a)).experience,0);
    assert.equal((await route.POST(req(a,"POST",confirm))).status,200);
    assert.equal((await summary(b)).experience,30,"re-recognition restores original ledger entry");
    assert.equal(await db.contributionRecord.count({where:{projectId:project.id,sourceKey:`task:${task.id}`}}),1);
    await db.projectKnowledgeItem.update({where:{id:knowledge.id},data:{archivedAt:new Date()}});
    assert.equal((await route.POST(req(a,"POST",adoption))).status,409);
    const own=await db.agentSubtask.create({data:{packageId:pkg.id,runId:randomBytes(8).toString("hex"),ordinal:1,objective:"Owner delivery",context:"fixture",assigneeId:a.id,status:"submitted",result:"Owner output"}});
    assert.equal((await route.POST(req(a,"POST",{...confirm,targetId:own.id}))).status,200);
    assert.equal((await summary(a)).experience,40,"self-review never gives review bonus");
    assert.equal((await route.POST(req(a,"POST",milestone))).status,200);
    assert.equal((await summary(a)).experience,60); assert.equal((await summary(b)).experience,50);
    const award=await db.contributionRecord.findFirstOrThrow({where:{projectId:project.id,kind:"milestone",revokedAt:null}});
    assert.equal((await route.POST(req(a,"POST",{...revoke,recordId:award.id}))).status,200);
    assert.equal((await summary(a)).experience,40); assert.equal((await summary(b)).experience,30);
    await db.agentSubtask.delete({where:{id:own.id}});
    const remaining=await (await route.GET(req(a,"GET",undefined,`?view=review&project=${project.id}`))).json();
    assert.ok(remaining.candidates.some((r:{targetId:string;eligible:boolean;recognized:boolean})=>r.targetId===own.id&&!r.eligible&&r.recognized),"deleted sources keep a revocation entry");
    await db.projectMember.delete({where:{projectId_userId:{projectId:project.id,userId:b.id}}});
    const hidden=await (await route.GET(req(b))).json();
    assert.equal(hidden.summary.experience,30); assert.ok(hidden.records.every((r:{href:unknown})=>r.href===null));
    assert.ok(!JSON.stringify(hidden).includes("SHARED_"),"lost membership hides source titles and notes");
    assert.equal((await route.POST(req(a,"POST",confirm))).status,409);
    assert.equal((await route.GET(req(a,"GET",undefined,"?page=0"))).status,400);
    const crossOrigin=new Request("http://localhost/api/me/contributions",{method:"POST",headers:{Origin:"https://foreign.example",Cookie:`scenarioforge_session=${a.token}`},body:JSON.stringify(confirm)});
    assert.equal((await route.POST(crossOrigin)).status,403);
  } finally {
    for (const projectId of projects) { await db.researchPackage.deleteMany({where:{projectId}}); await db.project.deleteMany({where:{id:projectId}}); }
    await db.user.deleteMany({where:{id:{in:actors.map(a=>a.id)}}}); await db.$disconnect();
  }
});
