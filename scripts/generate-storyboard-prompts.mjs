import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_BOOK_ROOT = "test-artifacts/novel-book";
const DEFAULT_OUTPUT = "storyboard-prompts.json";
const IMAGE_TYPES = ["main", "character", "object", "action", "triptych"];

const STYLE_PROMPT =
  "Cinematic realistic illustration, 2K landscape, cold blue rain, warm amber light, wet reflections, old copper, no text, no watermark.";

const CHARACTER_LOCKS = {
  "林知遥":
    "Lin Zhiyuan, teen boy with copper watch",
  "叶澜":
    "Ye Lan, black umbrella and shadow lines",
  "沈既白":
    "Shen Jibai, round glasses and blank pages",
  "宋砚":
    "Song Yan, mechanic with copper bird",
  "唐听雨":
    "Tang Tingyu, tired mentor with black umbrella",
  "林修远":
    "Lin Xiuyuan, clockmaker father",
  "林晚舟":
    "Lin Wanzhou, translucent copper-lit mother",
  "阿一":
    "A Yi, first-city child with lamp",
  "纪无眉":
    "Ji Wumei, dark coat and copper bell",
  "雨钟会领袖":
    "Rain Bell leader, gray coat and dark red veins"
};

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseOutline(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\.\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
      if (!match) {
        return null;
      }
      return {
        chapter: Number(match[1]),
        title: match[2].trim(),
        brief: match[3].trim()
      };
    })
    .filter(Boolean);
}

function pad(number, width = 3) {
  return String(number).padStart(width, "0");
}

function volumeName(chapter) {
  if (chapter <= 16) return "Volume I, Red-Copper Gate";
  if (chapter <= 32) return "Volume II, White Tower Lessons";
  if (chapter <= 48) return "Volume III, Undersea Clock";
  if (chapter <= 64) return "Volume IV, Reverse-Scale Archive";
  if (chapter <= 80) return "Volume V, Black Sun Alliance";
  return "Volume VI, Night of Returning Tide";
}

function has(text, pattern) {
  return pattern.test(text);
}

function chapterCharacters(title, brief) {
  const text = `${title} ${brief}`;
  const names = new Set(["林知遥"]);

  if (has(text, /叶澜|影线|黑伞|叶家|旧港决斗|影桥/)) names.add("叶澜");
  if (has(text, /宋砚|机械|机器鸟|机械鸟|机械群|避难图|城市坐标/)) names.add("宋砚");
  if (has(text, /沈既白|档案|空白|名字|失踪|谎言|写下/)) names.add("沈既白");
  if (has(text, /唐听雨|导师|铜灯|最后权限|归队|黑伞导师/)) names.add("唐听雨");
  if (has(text, /父亲|林父|林修远|表盘|钟表铺告别/)) names.add("林修远");
  if (has(text, /母亲|林晚舟|晚舟|录音|母亲的房间|门后母亲|门后使者/)) names.add("林晚舟");
  if (has(text, /阿一|第一城|灯兵|门后的军队/)) names.add("阿一");
  if (has(text, /纪无眉|旧友|叛离者/)) names.add("纪无眉");
  if (has(text, /雨钟会领袖|雨钟终局|黑塔|献祭|伪钥匙|双重背叛/)) names.add("雨钟会领袖");

  if (has(text, /主角组|预备队|队伍|临时同盟|最后/)) {
    names.add("叶澜");
    names.add("宋砚");
    names.add("沈既白");
  }

  return Array.from(names).slice(0, 5);
}

function characterText(names) {
  return names.slice(0, 3).map((name) => CHARACTER_LOCKS[name]).filter(Boolean).join("; ");
}

function compact(value, parts = 2) {
  return String(value).split(",").slice(0, parts).join(",").trim();
}

function settingFor(chapter, title, brief) {
  const text = `${title} ${brief}`;
  if (has(text, /钟表铺|旧城区|父亲店/)) {
    return "old clock repair shop in Linchuan Harbor, warm amber lamps, walls of ticking clocks, rainy glass storefront";
  }
  if (has(text, /白塔|书院|学院|图书馆|训练场|钟楼|课堂|入学|课程|停电|处分|最后一课/)) {
    return "hidden White Tower academy, rain-damp stone halls, copper mechanisms, archive corridors, clock tower shadows";
  }
  if (has(text, /港口|旧港|码头|仓库|灯塔|船坞|海堤/)) {
    return "old harbor district, wet piers, cranes, sea fog, emergency lights, black seawater and rain";
  }
  if (has(text, /地下|排水|赤铜门|门缝|开门|门区|封门/)) {
    return "underground red-copper gate chamber, wet ancient stone, dark water channels, massive copper rings";
  }
  if (has(text, /海底|沉城|潜航|潜艇|无声海图|海底钟/)) {
    return "undersea ruins and sunken city, cold blue water, ancient lamps, submerged clock tower, drifting silt";
  }
  if (has(text, /医院|病房|医学楼|灰潮病房/)) {
    return "clinical gray-tide ward, blue medical lights, rain on reinforced windows, charts and copper stabilizers";
  }
  if (has(text, /听证|政府|公开|城市|避难|迁徙|临川港暴雨/)) {
    return "Linchuan Harbor city under emergency evacuation, wet streets, blue safe-zone lights, citizens and volunteers";
  }
  if (has(text, /第一城|第二城|归潮|协议|全城钟鸣|赤铜门关闭/)) {
    return "boundary between reality, First City lamp streets, Second City black tide, and the red-copper gate protocol core";
  }
  return `${volumeName(chapter)} atmosphere, rain-soaked Linchuan Harbor and hidden modern fantasy details`;
}

function propFor(title, brief) {
  const text = `${title} ${brief}`;
  if (has(text, /录音|铜表/)) return "old copper wristwatch connected to a handmade audio device";
  if (has(text, /信|录取信/)) return "blank rain-damp admission letter with abstract non-readable traces";
  if (has(text, /档案|名单|病历|照片|图书馆/)) return "blank archive pages, old film strips, sealed folders, abstract unreadable marks";
  if (has(text, /机械|机器鸟|机械鸟|机械群/)) return "small copper mechanical bird, broken brass wings, black coils, watchlike joints";
  if (has(text, /伞|影线|叶澜/)) return "black umbrella, silver earring, thin shadow lines over wet ground";
  if (has(text, /铜灯|灯兵|灯火/)) return "old copper lamp with weak amber flame and rain-specked glass";
  if (has(text, /表盘|钥匙|齿轮/)) return "brass key, clock dial core, small copper gear marked only by abstract scratches";
  if (has(text, /钟|钟楼|共潮钟|海底钟|钟鸣/)) return "old copper bell or clock face, no readable numbers, rain and oxidized green patina";
  if (has(text, /灰潮|古相|黑日|黑潮/)) return "gray tide mist, black sun reflection, dark waterlike memory corrosion";
  if (has(text, /协议|边界|拒绝/)) return "red-copper protocol threads, paper records, distributed clock nodes, no readable text";
  return "old copper watch parts, wet paper, brass tools, and rainlit glass";
}

function supernaturalFor(title, brief) {
  const text = `${title} ${brief}`;
  if (has(text, /灰潮|污染|失控/)) return "gray tide memory pollution distorting time and identity at the edges of the frame";
  if (has(text, /赤铜门|门缝|开门|封门|归潮/)) return "red-copper gate light, boundary seams, ancient protocol geometry, black sea behind a narrow door crack";
  if (has(text, /影线|影桥|叶家/)) return "thin shadow lines bending distance and forming black geometric paths through rain";
  if (has(text, /海底|沉城|第一城|第二城/)) return "sunken city lights, First City lamps, Second City black tide, underwater memory architecture";
  if (has(text, /钟鸣|钟楼|共潮钟|表盘|坐标/)) return "all metal clocks vibrating in one low frequency, copper echoes spreading across wet streets";
  if (has(text, /档案|空白|名字|记忆/)) return "blank pages and erased memories becoming visible as pale mist, never readable text";
  if (has(text, /黑日|黑塔|献祭/)) return "black sun glare, broken broadcast tower, dark red ritual lines reflected in rain";
  return "faint rain shimmer on metal and clocks";
}

function actionFor(title, brief) {
  const text = `${title} ${brief}`;
  if (has(text, /救|逃|撤离|迁徙|避难/)) return "rescue movement through rain, volunteers and students guiding people across unstable boundaries";
  if (has(text, /追|决斗|攻入|陷落|背叛|终局/)) return "tense confrontation, sharp movement, rain spray, copper sparks, and supernatural force colliding";
  if (has(text, /训练|测验|课程|课堂/)) return "controlled but dangerous lesson scene, students facing a supernatural mechanism for the first time";
  if (has(text, /广播|电台|宣言|公开/)) return "urgent broadcast scene, cables, microphones, city lights, and truth spreading through the storm";
  if (has(text, /开门|关闭|协议|协商/)) return "ritual negotiation scene, people standing at boundaries rather than sacrificing themselves";
  if (has(text, /潜航|海底|上浮/)) return "underwater motion, pressure, searchlights, mechanical craft, and rising ruins";
  return "quiet tense moment";
}

function promptFor({ chapter, title, brief }, type, index) {
  const names = chapterCharacters(title, brief);
  const characters = characterText(names);
  const setting = settingFor(chapter, title, brief);
  const prop = propFor(title, brief);
  const supernatural = supernaturalFor(title, brief);
  const action = actionFor(title, brief);
  const place = compact(setting, 2);
  const clue = compact(prop, 2);
  const effect = compact(supernatural, 2);
  const movement = compact(action, 1);
  const withCharacters = characters ? ` Characters: ${characters}.` : "";
  const base = `${STYLE_PROMPT} ${place}.${withCharacters}`;

  if (type === "main") {
    return `${base} Wide shot, ${movement}, ${effect}.`;
  }
  if (type === "character") {
    return `${base} Medium shot, restrained emotion, wet fabric, copper light.`;
  }
  if (type === "object") {
    return `${STYLE_PROMPT} ${place}. Close still life: ${clue}, rain reflections, mystery mood.`;
  }
  if (type === "action") {
    return `${base} Dynamic shot, ${movement}, rain spray, copper sparks, readable composition.`;
  }

  return `${STYLE_PROMPT} Triptych storyboard, three horizontal panels, no text: ${place}; ${clue}; ${effect}.`;
}

function captionFor(entry, type, index) {
  const labels = {
    main: "主视觉",
    character: "人物情绪",
    object: "关键物件",
    action: "动作转折",
    triptych: "三联分镜"
  };
  return `图 ${entry.chapter}-${index} ${entry.title}${labels[type]}`;
}

function buildStoryboard(entries, existing = {}) {
  const existingById = new Map();
  for (const batch of existing.batches || []) {
    for (const item of batch.prompts || []) {
      existingById.set(item.id, item);
    }
  }

  const batches = [];
  for (let start = 1; start <= 96; start += 16) {
    const end = start + 15;
    const prompts = [];
    for (const entry of entries.filter((item) => item.chapter >= start && item.chapter <= end)) {
      IMAGE_TYPES.forEach((type, index) => {
        const imageNumber = index + 1;
        const id = `sb-ch${pad(entry.chapter)}-${pad(imageNumber, 2)}`;
        const old = existingById.get(id) || {};
        prompts.push({
          id,
          chapter: entry.chapter,
          type,
          caption: captionFor(entry, type, imageNumber),
          status: old.status === "created" ? "created" : "planned",
          path: `images/storyboard/sb-ch${pad(entry.chapter)}-${pad(imageNumber, 2)}.png`,
          metadata: old.metadata,
          prompt: promptFor(entry, type, imageNumber)
        });
      });
    }

    batches.push({
      id: `batch-${pad(Math.ceil(start / 16), 3)}`,
      chapters: `${pad(start)}-${pad(end)}`,
      promptCount: prompts.length,
      status: prompts.every((item) => item.status === "created") ? "created" : "planned",
      prompts
    });
  }

  return {
    project: "雨幕下的赤铜门",
    promptVersion: "v2-5-per-chapter",
    model: "gpt-image-2",
    size: "2048x1152",
    quality: "medium",
    outputDir: "test-artifacts/novel-book/images/storyboard",
    perChapter: 5,
    totalChapters: entries.length,
    totalPrompts: entries.length * IMAGE_TYPES.length,
    stylePrompt: STYLE_PROMPT,
    characterLocks: CHARACTER_LOCKS,
    batches
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bookRoot = resolve(args.bookRoot || DEFAULT_BOOK_ROOT);
  const outputPath = resolve(bookRoot, args.out || DEFAULT_OUTPUT);
  const outlinePath = resolve(bookRoot, "outline.md");
  const existing = existsSync(outputPath)
    ? JSON.parse(readText(outputPath))
    : {};
  const entries = parseOutline(readText(outlinePath));

  if (entries.length !== 96) {
    throw new Error(`Expected 96 outline entries, found ${entries.length}`);
  }

  const storyboard = buildStoryboard(entries, existing);
  writeJson(outputPath, storyboard);
  console.log(`STORYBOARD=${outputPath}`);
  console.log(`CHAPTERS=${storyboard.totalChapters}`);
  console.log(`PROMPTS=${storyboard.totalPrompts}`);
  console.log(`PER_CHAPTER=${storyboard.perChapter}`);
}

main();
