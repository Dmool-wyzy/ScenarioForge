import { test, expect, type Page } from "@playwright/test";
import type { NextAction } from "../lib/next-step-ranking";
import { mkdir } from "node:fs/promises";
const now = Date.parse("2026-11-09T08:00:00Z");
async function setup(page: Page, empty = false) {
  const projects = [
    { id: "a", name: "校园活动报名小助手", stars: 5, sortOrder: 0, role: "owner" },
    { id: "b", name: "课程设计 · 图书借阅系统", stars: 4, sortOrder: 0, role: "member" },
    { id: "c", name: "创新竞赛研究", stars: 2, sortOrder: 0, role: "member" },
  ].map(p => ({ ...p, inviteCode: "TEST01", createdAt: p.id, memberCount: 2, researchPackages: [] }));
  const action = (id: string, projectId: string, values: Partial<NextAction> = {}): NextAction => ({ id, projectId, projectName: projects.find(p=>p.id===projectId)!.name, stars: projects.find(p=>p.id===projectId)!.stars, title:"确认表单校验方案", detail:"初稿已就绪，检查或修改后确认提交给团队。", label:"打开我的任务", href:`/?project=${projectId}#personal-task-draft`, state:"ready", kind:"task", dueAt:null, waitingSince:"2026-11-08T08:00:00Z", blocksOthers:false, inProgress:true, ...values });
  const state = { failPriority: false, reads: 0, actions: empty ? [] : [action("task:wait","a",{state:"waiting",title:"研究正在生成中"}),action("task:draft","b"),action("task:another","b",{title:"补充重复报名验收点"}),action("task:urgent","c",{title:"确认竞赛选题的证据来源",dueAt:new Date(now+3600000).toISOString()})] };
  await page.route("**/api/**",async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(path==="/api/auth/me") return route.fulfill({json:{user:{id:"fixture-me",username:"nayun"}}});
    if(path==="/api/projects")return route.fulfill({json:{projects}});
    if(path==="/api/me/next-steps"){state.reads++;return route.fulfill({json:{actions:state.actions,warnings:[],generatedAt:new Date(now).toISOString()}});}
    if(path.endsWith("/my-priority")){
      if(state.failPriority)return route.fulfill({status:503,json:{error:"保存失败，请重试。"}});
      const p=projects.find(p=>p.id===path.split("/")[3])!;p.stars=req.postDataJSON().stars;
      return route.fulfill({json:{stars:p.stars}});
    }
    if(path==="/api/me/project-order"){
      const ids=req.postDataJSON().projectIds as string[];projects.forEach(p=>{if(ids.includes(p.id))p.sortOrder=ids.indexOf(p.id);});return route.fulfill({json:{ok:true}});
    }
    if(path.endsWith("/my-action")){
      const body=req.postDataJSON();state.actions.find(a=>a.id===body.actionKey)!.dueAt=body.dueAt;return route.fulfill({json:{dueAt:body.dueAt}});
    }
    if(path.endsWith("/model"))return route.fulfill({json:{settings:null,canEdit:false}});
    if(path.endsWith("/knowledge"))return route.fulfill({json:{total:0,results:[]}});
    if(path.endsWith("/repository"))return route.fulfill({json:{enabled:false}});
    if(path.endsWith("/personal-agent"))return route.fulfill({json:{settings:null,acceptsAgentTasks:false,tasks:[{id:"draft",objective:"确认表单校验方案",context:"fixture",status:"review",result:"示例交付",conversation:[],revision:0,canRecover:false,error:null,modelRequests:1,inputTokens:1,outputTokens:1,createdAt:new Date(now).toISOString(),package:{id:"pkg",title:"研究"}}]}});
    return route.fulfill({status:404,json:{error:"Unexpected fixture route"}});
  });
  await page.goto("/");await expect(page.getByRole("heading",{name:"我的下一步",exact:false})).toBeVisible();
  await expect(page.getByText("正在整理你的下一步…")).toHaveCount(0);
  return {state,projects};
}
const centre=(page:Page)=>page.getByRole("region",{name:"我的下一步",exact:true});
test("high-priority waiting projects are skipped; low-priority urgent items remain separate",async({page})=>{
  await setup(page);
  await expect(page.locator(".sf-next-featured")).toContainText("课程设计");
  await expect(page.locator(".sf-next-urgent")).toContainText("创新竞赛");
  await expect(centre(page).getByRole("button",{name:"本项目另有 1 项"})).toBeVisible();
  await centre(page).getByRole("button",{name:"等待中 1"}).click();
  await expect(centre(page).getByRole("heading",{name:"研究正在生成中"})).toBeVisible();
});
test("stars persist on reload and failed saves keep the previous selection",async({page})=>{
  const {state}=await setup(page);
  const card=page.locator(".sf-project-card").filter({has:page.getByRole("heading",{name:/创新竞赛研究/})});
  await card.getByRole("radio",{name:"5 星",exact:true}).click();
  await expect(page.locator(".sf-next-featured")).toContainText("创新竞赛");
  await page.reload();await expect(card.getByRole("radio",{name:"5 星",exact:true})).toBeChecked();
  state.failPriority=true;await card.getByRole("radio",{name:"1 星",exact:true}).click();
  await expect(page.getByRole("alert").filter({hasText:"保存失败"})).toBeVisible();
  await expect(card.getByRole("radio",{name:"5 星",exact:true})).toBeChecked();
});
test("same-star project order persists and moving across star groups is disabled",async({page})=>{
  await setup(page);
  const c=page.locator(".sf-project-card").filter({has:page.getByRole("heading",{name:/创新竞赛研究/})});
  await expect(c.getByRole("button",{name:"上移创新竞赛研究"})).toBeDisabled();
  await c.getByRole("radio",{name:"4 星",exact:true}).click();
  await expect(c.getByRole("radio",{name:"4 星",exact:true})).toBeChecked();
  await c.getByRole("button",{name:"上移创新竞赛研究"}).click();
  await expect(page.locator(".sf-project-card").nth(1)).toContainText("创新竞赛研究");
  await page.reload();await expect(page.locator(".sf-project-card").nth(1)).toContainText("创新竞赛研究");
});
test("all actions, project filter and personal deadline controls work",async({page})=>{
  await setup(page);
  await centre(page).getByRole("button",{name:"本项目另有 1 项"}).click();
  await expect(page.locator(".sf-next-all article")).toHaveCount(2);
  const first=page.locator(".sf-next-all article").first();
  await first.getByText("设置我的截止时间",{exact:true}).click();
  await first.getByLabel("我的截止时间",{exact:true}).fill("2026-11-10T12:00");
  await first.getByRole("button",{name:"保存时间"}).click();
  await expect(first.locator("summary")).toContainText("我的截止");
  await first.locator("summary").click();await first.getByRole("button",{name:"清除时间"}).click();
  await expect(first.locator("summary")).toContainText("设置我的截止时间");
  await centre(page).getByRole("combobox",{name:"筛选项目"}).selectOption("c");
  await expect(page.locator(".sf-next-all article")).toHaveCount(1);
});
test("completion refresh removes a task; links reveal the actual task panel",async({page})=>{
  const {state}=await setup(page);
  const link=page.locator(".sf-next-featured h3").getByRole("link");
  await link.click();
  await expect(page.locator("#personal-task-draft")).toBeFocused();
  await expect(page.locator("#personal-task-draft")).toBeInViewport();
  await page.getByRole("button",{name:"← 返回项目"}).click();
  state.actions=state.actions.filter(a=>a.projectId!=="b");
  await centre(page).getByRole("button",{name:"↻ 刷新待办"}).click();
  await expect(page.locator(".sf-next-featured")).toContainText("创新竞赛");
});
test("empty state remains useful and deadline settings do not appear without tasks",async({page})=>{
  await setup(page,true);await expect(centre(page)).toContainText("当前没有需要你处理的事项");
  await expect(centre(page).getByText("设置我的截止时间",{exact:true})).toHaveCount(0);
});
test("deadline reminder shows urgent ready and waiting actions together",async({page})=>{
  const {state}=await setup(page);
  state.actions[0].dueAt=new Date(now-3600000).toISOString();
  await centre(page).getByRole("button",{name:"↻ 刷新待办"}).click();
  await expect(page.locator(".sf-next-urgent")).toContainText("截止提醒 · 2 项");
  await centre(page).getByRole("button",{name:"等待中 1"}).click();
  await centre(page).getByRole("button",{name:"查看截止提醒",exact:true}).click();
  await expect(page.locator(".sf-next-all article")).toHaveCount(2);
  await expect(page.locator(".sf-next-all article").first()).toContainText("研究正在生成中");
  await expect(page.locator(".sf-next-all")).toContainText("确认竞赛选题的证据来源");
});
test("task-provided deadlines are automatic, read-only and used by urgent reminders",async({page})=>{
  const {state}=await setup(page);
  const action=state.actions.find(a=>a.id==="task:another")!;
  action.dueAt=new Date(now+3600000).toISOString();action.deadlineSource="task";action.deadlinePrecision="time";
  await centre(page).getByRole("button",{name:"↻ 刷新待办"}).click();
  const featured=page.locator(".sf-next-featured");
  await expect(featured.locator(".sf-action-deadline-fixed")).toContainText("任务截止：");
  await expect(featured.locator(".sf-action-deadline-fixed")).toContainText("来自任务描述 · 北京时间");
  await expect(featured.locator(".sf-action-deadline-fixed")).toContainText("17:00");
  await expect(featured.getByText("设置我的截止时间",{exact:true})).toHaveCount(0);
  await expect(featured.locator('input[type="datetime-local"]')).toHaveCount(0);
  await expect(page.locator(".sf-next-urgent")).toContainText(action.title);
  action.deadlinePrecision="date";
  await centre(page).getByRole("button",{name:"↻ 刷新待办"}).click();
  await expect(featured.locator(".sf-action-deadline-fixed")).toContainText("当日结束");
  await expect(featured.locator(".sf-action-deadline-fixed")).toContainText("来自任务描述");
  action.dueAt=null;action.deadlineSource=null;action.deadlinePrecision=null;
  await centre(page).getByRole("button",{name:"↻ 刷新待办"}).click();
  const undated=centre(page).locator(".sf-next-action").filter({has:page.getByRole("link",{name:action.title,exact:true})});
  await expect(undated.locator(".sf-action-deadline-fixed")).toHaveCount(0);
  await expect(undated.getByText("设置我的截止时间",{exact:true})).toBeVisible();
});
test("old delivery links load and reveal a row beyond the repository list",async({page})=>{
  const {state}=await setup(page);
  state.actions[1].href="/?project=b#delivery-old";
  state.actions[1].waitingSince="2026-11-01T00:00:00Z";
  await page.route("**/api/projects/b/repository*",async route=>route.fulfill({json:new URL(route.request().url()).searchParams.has("delivery")
    ? {id:"old",objective:"较早提交的待审查交付",assigneeName:"member",mine:true,git:null}
    : {enabled:true,head:"a".repeat(40),tasks:[],files:[]}}));
  await centre(page).getByRole("button",{name:"↻ 刷新待办"}).click();
  await page.locator(".sf-next-featured").getByRole("link",{name:"打开我的任务"}).click();
  await expect(page.locator("#delivery-old")).toBeFocused();
  await expect(page.locator("#delivery-old")).toBeInViewport();
  await expect(page.locator("#delivery-old").getByRole("button",{name:"保存我的交付到任务分支"})).toBeVisible();
});
for(const width of [1440,390])test(`personal homepage layout at ${width}px has no horizontal overflow`,async({page})=>{
  await page.setViewportSize({width,height:width===1440?1100:844});await setup(page);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  if(width===1440){
    const first=await page.locator(".sf-next-grid article").first().boundingBox();
    const last=await page.locator(".sf-next-grid article").last().boundingBox();
    const section=await centre(page).boundingBox();
    expect(first!.y).toBe(last!.y);
    expect(section!.x+section!.width-last!.x-last!.width).toBeLessThan(35);
  }
  await mkdir(".tmp/next-steps-preview",{recursive:true});
  await page.screenshot({path:`.tmp/next-steps-preview/home-${width}.png`,fullPage:true});
});

test("clicking the task card background opens the project's task",async({page})=>{
  await setup(page);
  await page.locator(".sf-next-featured").click({position:{x:5,y:5}});
  await expect(page).toHaveURL(/project=b#personal-task-draft$/);
  await expect(page.locator("#personal-task-draft")).toBeFocused();
  await expect(page.locator("#personal-task-draft")).toBeInViewport();
});
