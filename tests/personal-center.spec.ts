import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
async function setup(page: Page) {
  const profile = { nickname:"小林", avatar:"leaf", bio:"在团队中积累，让下一次做得更好。", specialty:"软件工程", skills:["React","调研"], agentStyle:"balanced", agentTech:"React", agentDelivery:"附运行步骤", agentNotes:"" };
  const state = { profile, user:{username:"lin",createdAt:"2026-11-01T00:00:00Z"}, projects:[{id:"p1",name:"校园活动报名系统"},{id:"p2",name:"课程研究项目"}], sessions:[{id:"s1",device:"Windows · Edge",current:true,createdAt:"2026-11-09T04:00:00Z",expiresAt:"2026-11-16T04:00:00Z"},{id:"s2",device:"Android · Chrome",current:false,createdAt:"2026-11-08T04:00:00Z",expiresAt:"2026-11-15T04:00:00Z"}], favorites:[{id:"f1",kind:"file",tags:["验收"],note:"答辩时参考",createdAt:"2026-11-09T04:00:00Z",source:{title:"RESEARCH.md",content:"报名系统需要验证重复报名、名额上限和取消报名三项行为。",context:"校园活动研究",href:"/?project=p1&package=pkg&file=RESEARCH.md",projectId:"p1"}},{id:"f2",kind:"message",tags:[],note:"",createdAt:"2026-11-08T04:00:00Z",source:null}], fail:false, modelCalls:[] as string[], settings:null as object|null };
  await page.route("**/api/**",async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(path==="/api/auth/me")return route.fulfill({json:{user:{id:"u",username:"lin"}}});
    if(path==="/api/me/profile"||path==="/api/me/agent-preferences"){
      if(req.method()==="GET")return route.fulfill({json:state});
      if(state.fail)return route.fulfill({status:500,json:{error:"保存失败，请重试。"}});
      Object.assign(state.profile,req.postDataJSON());return route.fulfill({json:{ok:true}});
    }
    if(path==="/api/me/security"){
      if(req.method()==="GET")return route.fulfill({json:{sessions:state.sessions}});
      state.sessions=state.sessions.filter(s=>s.current);return route.fulfill({json:{ok:true}});
    }
    if(path==="/api/me/favorites"){
      if(req.method()==="GET")return route.fulfill({json:{favorites:state.favorites}});
      const input=req.postDataJSON();
      if(req.method()==="PATCH")Object.assign(state.favorites.find(f=>f.id===input.id)!,input);
      if(req.method()==="DELETE")state.favorites=state.favorites.filter(f=>f.id!==input.id);
      return route.fulfill({json:{ok:true}});
    }
    if(path.endsWith("/personal-agent")){
      state.modelCalls.push(path);
      if(req.method()==="PUT")state.settings={...req.postDataJSON().settings,hasApiKey:true};
      return route.fulfill({json:{settings:state.settings,acceptsAgentTasks:false,tasks:[]}});
    }
    return route.fulfill({status:404,json:{error:"unhandled fixture"}});
  });
  await page.goto("/profile");await expect(page.getByRole("heading",{name:"个人资料",exact:true})).toBeVisible();
  return state;
}
test("profile saves and reloads, failed changes stay editable",async({page})=>{
  const state=await setup(page);
  await page.getByLabel("昵称",{exact:true}).fill("林同学");await page.getByRole("button",{name:"星星头像",exact:true}).click();await page.getByLabel("技能标签").fill("React、TypeScript");
  await page.getByRole("button",{name:"保存资料",exact:true}).click();await expect(page.getByRole("status")).toContainText("个人资料已保存");
  await page.reload();await expect(page.getByLabel("昵称",{exact:true})).toHaveValue("林同学");await expect(page.getByRole("button",{name:"星星头像",exact:true})).toHaveAttribute("aria-pressed","true");
  state.fail=true;await page.getByLabel("昵称",{exact:true}).fill("未保存");await page.getByRole("button",{name:"保存资料",exact:true}).click();await expect(page.locator("main").getByRole("alert")).toContainText("保存失败");await expect(page.getByRole("heading",{level:1})).toContainText("林同学");
});
test("local avatar previews, persists, and can be replaced by a preset",async({page})=>{
  const state=await setup(page);
  const file=await sharp({create:{width:120,height:80,channels:3,background:"#3f8096"}}).png().toBuffer();
  const upload=page.getByLabel("本地头像文件",{exact:true});
  await upload.setInputFiles({name:"my-avatar.png",mimeType:"image/png",buffer:file});
  await expect(page.getByRole("img",{name:"待保存的头像预览"})).toBeVisible();
  expect(state.profile.avatar).toBe("leaf");
  await page.getByRole("button",{name:"保存资料",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("个人资料已保存");
  expect(state.profile.avatar).toMatch(/^data:image\/webp;base64,/);
  await page.reload();await expect(page.getByRole("img",{name:"我的头像",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"选择本地头像"})).toHaveAttribute("aria-pressed","true");
  await upload.setInputFiles({name:"fake.png",mimeType:"image/png",buffer:Buffer.from("not an image")});
  await expect(page.locator("main").getByRole("alert")).toContainText("图片无法读取");
  await expect(page.getByRole("img",{name:"我的头像",exact:true})).toBeVisible();
  await upload.setInputFiles({name:"large.png",mimeType:"image/png",buffer:Buffer.alloc(5*1024*1024+1)});
  await expect(page.locator("main").getByRole("alert")).toContainText("不能超过 5 MB");
  await page.getByRole("button",{name:"暖阳头像",exact:true}).click();await page.getByRole("button",{name:"保存资料",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("个人资料已保存");await page.reload();
  await expect(page.getByRole("img",{name:"我的头像",exact:true})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"暖阳头像",exact:true})).toHaveAttribute("aria-pressed","true");
});
test("agent preferences and existing project model management are accessible",async({page})=>{
  const state=await setup(page);await page.getByRole("button",{name:"个人 Agent"}).click();
  await page.getByLabel("回答风格").selectOption("concise");await page.getByLabel("技术偏好").fill("React + TypeScript");await page.getByRole("button",{name:"保存工作偏好",exact:true}).click();await expect(page.getByRole("status")).toContainText("工作偏好已保存");
  await page.getByLabel("选择项目",{exact:true}).selectOption("p2");await expect.poll(()=>state.modelCalls.includes("/api/projects/p2/personal-agent")).toBe(true);
  await expect(page.getByLabel("API Base URL")).toBeVisible();await expect(page.getByLabel("个人 Agent 任务收件箱",{exact:true})).toHaveCount(0);
  await page.getByLabel("API Base URL").fill("https://api.example.com/v1");await page.getByLabel("API Key",{exact:true}).fill("fixture-key");await page.getByLabel("模型 ID").fill("model-fixture");await page.getByRole("button",{name:"保存个人设置",exact:true}).click();await expect(page.getByText("个人 Agent 配置已保存。",{exact:true})).toBeVisible();
  await expect(page.getByLabel("API Key",{exact:true})).toHaveValue("");await page.reload();await expect(page.getByLabel("回答风格")).toHaveValue("concise");
});
test("password confirmation and session revocation are clear",async({page})=>{
  await setup(page);await page.getByRole("button",{name:"账号安全"}).click();await expect(page.getByText("Android · Chrome")).toBeVisible();
  await page.getByLabel("当前密码",{exact:true}).fill("current-password");await page.getByLabel("新密码",{exact:true}).fill("new-password");await page.getByLabel("确认新密码",{exact:true}).fill("mismatch-password");await page.getByRole("button",{name:"更新密码",exact:true}).click();await expect(page.locator("main").getByRole("alert")).toContainText("两次输入的新密码不一致");
  await page.getByLabel("确认新密码",{exact:true}).fill("new-password");await page.getByRole("button",{name:"更新密码",exact:true}).click();await expect(page.getByRole("status")).toContainText("密码已更新");await expect(page.getByText("Android · Chrome")).toHaveCount(0);await expect(page.getByText("当前登录",{exact:true})).toBeVisible();
});
test("favorites can be searched, tagged and removed without revealing unavailable content",async({page})=>{
  await setup(page);await page.getByRole("button",{name:"我的收藏"}).click();await expect(page.getByText("原内容已不可访问",{exact:true})).toBeVisible();
  await page.getByLabel("搜索收藏",{exact:true}).fill("验收");await expect(page.getByText("原内容已不可访问",{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"编辑标签与笔记",exact:true}).click();await page.getByLabel("标签",{exact:true}).fill("作品集、可复用");await page.getByLabel("个人笔记",{exact:true}).fill("下一次项目复用");await page.getByRole("button",{name:"保存收藏信息",exact:true}).click();
  await page.getByLabel("搜索收藏",{exact:true}).fill("可复用");await expect(page.getByText("我的笔记：下一次项目复用")).toBeVisible();await expect(page.getByRole("link",{name:"RESEARCH.md ↗"})).toHaveAttribute("href","/?project=p1&package=pkg&file=RESEARCH.md");await page.getByRole("button",{name:"取消收藏",exact:true}).click();await expect(page.getByText("没有匹配的收藏",{exact:true})).toBeVisible();
});
test("desktop and mobile personal center stay within viewport",async({page})=>{
  await setup(page);await mkdir(".tmp/personal-center-preview",{recursive:true});
  await page.setViewportSize({width:1440,height:1050});await page.screenshot({path:".tmp/personal-center-preview/desktop.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  for(const name of ["个人资料","个人 Agent","账号安全","我的收藏"]){
    await page.getByRole("button",{name}).click();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.screenshot({path:".tmp/personal-center-preview/mobile.png",fullPage:true});
});
