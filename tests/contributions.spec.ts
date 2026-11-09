import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { CONTRIBUTION_LEVELS } from "../lib/contribution-levels";

async function setup(page: Page, experience = 180, owner = true) {
  const project = { id:"p1",name:"校园活动报名系统",role:owner?"owner":"member" };
  const state = { experience, fail:false, writes:[] as Record<string, unknown>[], records:[{id:"r1",projectId:"p1",kind:"task",points:30,title:"报名流程验收方案",note:"逐项核对了报名、取消及名额上限，符合交付要求。",revokeReason:"",revokedAt:null as string|null,createdAt:"2026-11-09T05:00:00Z",projectName:project.name,href:"/?project=p1&package=pkg#delivery-t1"},{id:"r2",projectId:"p2",kind:"knowledge",points:10,title:"课程项目的参考资料",note:"来源与研究结论一致，已确认采纳。",revokeReason:"",revokedAt:null as string|null,createdAt:"2026-11-08T05:00:00Z",projectName:"课程研究项目",href:"/?project=p2#project-knowledge"}], recognized:false };
  const profile={nickname:"小林",avatar:"leaf",bio:"把每一次协作，变成下一次成长的起点。",specialty:"软件工程",skills:["React"],agentStyle:"balanced",agentTech:"",agentDelivery:"",agentNotes:""};
  await page.route("**/api/**",async route=>{
    const request=route.request(), url=new URL(request.url());
    if(url.pathname==="/api/auth/me") return route.fulfill({json:{user:{id:"u1",username:"lin"}}});
    if(url.pathname==="/api/me/profile") return route.fulfill({json:{user:{username:"lin",createdAt:"2026-11-01T00:00:00Z"},profile,projects:[project],growth:{experience:state.experience}}});
    if(url.pathname==="/api/me/contributions") {
      if(request.method()==="POST") {
        const body=request.postDataJSON();state.writes.push(body);
        if(state.fail) return route.fulfill({status:409,json:{error:"贡献状态已变化，请重新检查。"}});
        state.recognized=body.action==="confirm";state.experience=state.recognized?experience+10:experience;
        return route.fulfill({json:{ok:true}});
      }
      if(url.searchParams.get("view")==="review") return route.fulfill({json:{limited:false,candidates:[{kind:"task",targetId:"t1",title:"报名流程验收方案",content:"检查重复报名、名额上限和取消报名。",author:"小陈",href:"/?project=p1&package=pkg#delivery-t1",eligible:true,recognized:state.recognized,recordId:state.recognized?"review-r1":null,note:state.recognized?"已检查重复报名与名额上限，结果符合验收要求。":""}]}});
      const rows=state.records.filter(r=>!url.searchParams.get("project")||r.projectId===url.searchParams.get("project"));
      return route.fulfill({json:{summary:{experience:state.experience,counts:{task:3,knowledge:2,review:1,milestone:0}},total:rows.length,page:1,projects:[project,{id:"p2",name:"课程研究项目",role:"member"}],records:rows}});
    }
    return route.fulfill({status:404,json:{error:"unhandled fixture"}});
  });
  await page.goto("/profile?tab=contributions");await expect(page.getByRole("heading",{name:"贡献记录",exact:true})).toBeVisible();
  await expect(page.getByRole("link",{name:"报名流程验收方案 ↗",exact:true})).toBeVisible();
  return state;
}

test("contribution filters, links and member view",async({page})=>{
  await setup(page,180,false);
  await expect(page.getByRole("region",{name:"个人等级：Lv.2 参与者"})).toBeVisible();
  await expect(page.getByRole("button",{name:"项目贡献审核"})).toHaveCount(0);
  await page.getByLabel("筛选贡献项目").selectOption("p1");
  await expect(page.getByRole("link",{name:"课程项目的参考资料 ↗"})).toHaveCount(0);
  await expect(page.getByRole("link",{name:"报名流程验收方案 ↗"})).toHaveAttribute("href","/?project=p1&package=pkg#delivery-t1");
  await expect(page.getByRole("region",{name:"个人等级：Lv.2 参与者"})).toContainText("180");
});
test("owner confirms, handles failure and revokes contribution",async({page})=>{
  const state=await setup(page);
  await page.getByRole("button",{name:"项目贡献审核"}).click();
  await page.getByText("检查交付内容",{exact:true}).click();
  await expect(page.getByText("检查重复报名、名额上限和取消报名。",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"审核并认可",exact:true}).click();
  const reason="已检查重复报名与名额上限，结果符合验收要求。";
  await page.getByLabel("检查内容与认可理由").fill(reason);state.fail=true;
  await page.getByRole("button",{name:"确认认可贡献",exact:true}).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("贡献状态已变化");
  await expect(page.getByLabel("检查内容与认可理由")).toHaveValue(reason);
  state.fail=false;await page.getByRole("button",{name:"确认认可贡献",exact:true}).click();
  await expect(page.locator(".sf-profile-success")).toContainText("贡献已认可");
  await expect(page.getByRole("region",{name:"个人等级：Lv.2 参与者"})).toContainText("190");
  expect(state.writes.at(-1)).toEqual({action:"confirm",projectId:"p1",kind:"task",targetId:"t1",note:reason});
  await page.getByRole("button",{name:"撤销认定",exact:true}).click();await page.getByLabel("撤销原因").fill("复核发现关键场景缺失，撤销认定。");
  await page.getByRole("button",{name:"确认撤销认定",exact:true}).click();
  await expect(page.locator(".sf-profile-success")).toContainText("相关经验已回退");
  await expect(page.getByRole("region",{name:"个人等级：Lv.2 参与者"})).toContainText("180");
});
test("all seven card styles, max level and responsive layouts",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await setup(page,9999);await mkdir(".tmp/contribution-preview",{recursive:true});
  await page.setViewportSize({width:1440,height:1100});
  await expect(page.getByRole("region",{name:"个人等级：Lv.7 项目狂人"})).toContainText("9,999");
  await expect(page.getByRole("region",{name:"个人等级：Lv.7 项目狂人"}).getByRole("progressbar")).toHaveAttribute("aria-valuenow","100");
  await page.screenshot({path:".tmp/contribution-preview/desktop.png",fullPage:true});
  await page.getByText("成长规则与等级图鉴",{exact:false}).first().click();
  for(const rank of CONTRIBUTION_LEVELS){
    await page.getByRole("button",{name:`Lv.${rank.level} ${rank.name} ${rank.threshold.toLocaleString("zh-CN")} EXP`,exact:true}).click();
    const card=page.getByRole("region",{name:`预览：Lv.${rank.level} ${rank.name}`,exact:true});await expect(card).toBeVisible();
    await card.screenshot({path:`.tmp/contribution-preview/level-${rank.level}.png`});
  }
  await page.emulateMedia({reducedMotion:"reduce"});
  expect(await page.locator(".sf-level-7").first().evaluate(el=>getComputedStyle(el,"::after").animationName)).toBe("none");
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:".tmp/contribution-preview/mobile.png",fullPage:true});
  await page.getByRole("button",{name:"个人资料",exact:true}).click();
  await expect(page.getByRole("button",{name:"查看贡献与等级 ↗",exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
