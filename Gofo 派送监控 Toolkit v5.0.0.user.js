// ==UserScript==
// @license MIT
// @name         Gofo 派送监控 Toolkit v5.0.0
// @namespace    http://tampermonkey.net/
// @version      5.0.0
// @description  自动生成晚报、催未派送、催百分比，小红花，适配新版站点看板派送报表，新增Performance 功能
// @author       George Zhao (based on original toolkit by Miku Chu)
// @match        *://*.gofoexpress.com/*
// @require      https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// ==/UserScript==
// @run-at document-start

// ************ 全局变量 ************/
// ************ 获取 station 信息 ************/
// BODY 参数格式：
//   {
//   groupDateType: String,      // 分组日期类型（day / week / month）
//   stationIds: Number[],       // 站点 ID 数组
//   groupType: String,          // 分组类型（如 "1"）
//   postCode: String,           // 邮编（空字符串表示不过滤）
//   courierWorkAreas: null | any, // 司机工作区域（null 表示不过滤）
//   startTime: String,          // 开始日期（YYYY-MM-DD）
//   endTime: String,            // 结束日期（YYYY-MM-DD）
//   queryStartTime: String,     // 查询开始时间
//   queryEndTime: String,       // 查询结束时间
// }
// Response 参数格式：
//   {
//   params: null,
//   code: 200,
//   status: 1,
//   message: "成功",
//   data: [
//     {
//       groupDate: String, // 日期（如 01/06/2026）
//       site: Number, // 站点 ID
//       siteName: String, // 站点名称
//       pickUpCnt: Number, // 应取件量
//       checkOutPieces: Number, // 应派件量
//       taskWaybillNoCnt: Number, // 应派件量
//       podPieces: Number, // 已妥投
//       returnCenter: Number, // 已退回站点
//       returnSite: Number, // 已退回站点
//       deliveryFailPieces: Number, // 派送失败
//       reassigned: Number, // 已重派
//       deliveringPieces: Number, // 派送中
//       deliveryCnt: Number, // 派送次数
//       podRate: Number, // 妥投率
//       podRate2400: Number, // 2400妥投率
//       podRate4800: Number, // 4800妥投率
//       podRate7200: Number, // 7200妥投率
//       podRate9600: Number, // 9600妥投率
//     },
//   ],
// }

const STATION_INFO_URL =
  "/prod-api/dbu_report/common/site/dashboard/magic/getPodDetailsGroupSite";

const STATION_SUMMARY_INFO_URL =
  "/prod-api/dbu_report/common/site/dashboard/magic/statisticsByDimensions";
// 中心看板
const STATION_DAILY_REPORT_URL =
  "/prod-api/dbu_report/common/site/dashboard/magic/getDeliveryMonitoringStatistics";
// {
// 疑似丢失和虚假签收
//   numberCodeList: ["2020", "2021"],
//   createGroupIdList: [],
//   assigneeGroupList: [],
//   handleCommandList: [],
//   dutyGroupList: [
//     77, 413, 551, 321, 133, 1127, 975, 882, 808, 784, 783, 728, 653, 395, 73,
//     382, 349, 297, 224, 337, 203,
//   ],
//   handleResultList: [],
//   arbitrationHandlerIdList: [],
//   beginTime: "2026-01-09 00:00:00",
//   endTime: "2026-01-11 23:59:59",
//   timeType: 1,
//   sort: 1,
// },
const WORKSPACE_URL =
  "/prod-api/epss/web/work/processing/page?pageNum=1&pageSize=1000";
const WORKSPACE_PACKAGE_DETAIL_URL = "/prod-api/epss/web/abnormal/v2/info";
// 获取站点DSP列表
const STATION_DSP_IDS_URL = "/prod-api/report/operation/listLineDeptNew";
// 获取目前用户所有站点
const CURRENT_STATIONS_URL = "/prod-api/base/group-info/activeGroupTree";
// 获取上下架信息
const ON_SHELVES_AND_OFF_SHELVES_URL =
  "/prod-api/dbu_report/common/magic/center/return/operator/cnt";
// 主链接
const DOMAIN_URL = "https://dms.gofoexpress.com";
// 用户token
let TOKEN = localStorage.getItem("Admin-Token");
// 小红花的前三名emoji
const AWARD_EMOJI_FOR_DSP_PERFORMANCE = ["🏆", "🥈", "🥉"];

(function () {
  ("use strict");
  let stationInfoCache = {};
  let stationDSPInfoCache = [];
  let stationDSPIds = [];
  let currentDates = "";
  let currentStations = "";
  let workspaceDataCache = null;
  let centerSummaryCache = null;
  // ************ helper function ************/
  const calculatePodRate = (checkOutPieces, podPieces, reassigned = 0) => {
    if (!checkOutPieces) return 0;
    const rate = ((podPieces + reassigned) / checkOutPieces) * 100;
    return Math.round((rate + Number.EPSILON) * 100) / 100;
  };

  // 复制到粘贴板
  const copyToClipboard = (text) => {
    try {
      // 优先尝试 GM_setClipboard（Tampermonkey/GreaseMonkey）
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text);
        return;
      }
    } catch (err) {
      console.warn("复制失败", err);
    }

    // fallback 到标准 Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => console.log("复制成功"))
        .catch((err) => console.error("复制失败", err));
    } else {
      alert("无法复制到剪贴板");
    }
  };

  // 获取站点DSP列表
  const getStationDSPIds = () => {
    TOKEN = localStorage.getItem("Admin-Token");
    if (!TOKEN) {
      alert("无法读取TOKEN，请刷新网页后重试");
      return Promise.reject(new Error("Missing TOKEN"));
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: STATION_DSP_IDS_URL,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        onload: (res) => {
          try {
            const response = JSON.parse(res.responseText);
            if (!Array.isArray(response.data)) {
              resolve([]);
              return;
            }

            const deptIdNumberList = response.data
              .map((item) => Number(item.deptId))
              .filter((id) => Number.isFinite(id));

            stationDSPIds = deptIdNumberList;

            resolve(deptIdNumberList);
          } catch (e) {
            reject(e);
          }
        },
        onerror: (err) => reject(err),
      });
    });
  };

  // 获取工作台的日期，今天和前两天
  const getCurrentDates = () => {
    const now = new Date(); // 本地时间

    const formatYMD = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    const endDate = formatYMD(now);

    const begin = new Date(now);
    begin.setDate(now.getDate() - 2);
    const beginDate = formatYMD(begin);

    return {
      beginTime: `${beginDate} 00:00:00`,
      endTime: `${endDate} 23:59:59`,
    };
  };

  // 发送请求获取虚假签收和疑似丢失数据
  const getSuspectLostAndFakePods = async () => {
    TOKEN = localStorage.getItem("Admin-Token");
    if (!TOKEN) {
      alert("❌ 未找到 Admin-Token（localStorage）");
      return [];
    }

    const { endTime, beginTime } = getCurrentDates();
    await getStationDSPIds();
    const url = `${location.origin}${WORKSPACE_URL}`;

    const body = {
      numberCodeList: ["2020", "2021"],
      createGroupIdList: [],
      assigneeGroupList: [],
      handleCommandList: [],
      dutyGroupList: stationDSPIds,
      handleResultList: [],
      arbitrationHandlerIdList: [],
      beginTime,
      endTime,
      timeType: 1,
      sort: 4,
    };

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        anonymous: false,
        withCredentials: true,
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          Authorization: `Bearer ${TOKEN}`,
          lang: "en",
          timeZone: "GMT-0600",
          "Date-Time-Format": "MM/dd/yyyy HH:mm:ss",
          "User-Time-Zone": "America/Chicago",
        },
        data: JSON.stringify(body),

        onload: async (res) => {
          const text = res.responseText || "";

          if (res.status !== 200) {
            reject(new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`));
            return;
          }

          if (text.trim().startsWith("<")) {
            reject(
              new Error(`返回 HTML（可能登录失效）: ${text.slice(0, 200)}`),
            );
            return;
          }

          try {
            const data = JSON.parse(text);
            const list =
              data?.data?.list ||
              data?.data?.records ||
              (Array.isArray(data?.data) ? data.data : []);

            // // 并行 + 限并发
            const limit = pLimit(50);

            await Promise.all(
              list.map((item) =>
                limit(async () => {
                  try {
                    const detail = await getSuspectLostAndFakePodDetail(
                      item.actId,
                    );
                    item.detail = detail;
                  } catch (e) {
                    item.detail = null;
                    item.detailError = String(e?.message || e);
                  }
                }),
              ),
            );
            // await Promise.all(
            //   list.map(async (item) => {
            //     try {
            //       const detail = await getSuspectLostAndFakePodDetail(
            //         item.actId,
            //       );
            //       item.detail = detail;
            //     } catch (e) {
            //       item.detail = null;
            //       item.detailError = String(e?.message || e);
            //     }
            //   }),
            // );

            resolve(list);
          } catch (e) {
            reject(
              new Error(
                `JSON 解析失败: ${e.message}; preview=${text.slice(0, 200)}`,
              ),
            );
          }
        },

        onerror(err) {
          reject(err);
        },
      });
    });
  };

  //  根据 actId 来获取更为详细的信息
  const getSuspectLostAndFakePodDetail = async (actId) => {
    TOKEN = localStorage.getItem("Admin-Token");
    const url = `${location.origin}${WORKSPACE_PACKAGE_DETAIL_URL}`;
    return new Promise((resolve, reject) => {
      if (!TOKEN) {
        reject("未找到 Admin-Token（可能登录过期）");
        return;
      }

      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json, text/plain, */*",
          lang: "en",
          timeZone: "GMT-0600",
        },

        data: JSON.stringify({
          abnormalId: actId,
        }),

        onload: function (res) {
          try {
            if (res.status !== 200) {
              reject(`HTTP错误: ${res.status}`);
              return;
            }
            const json = JSON.parse(res.responseText);
            resolve(json.data);
          } catch (e) {
            reject("返回数据不是合法 JSON");
          }
        },

        onerror: function (err) {
          reject(err);
        },

        ontimeout: function () {
          reject("请求超时");
        },
      });
    });
  };

  // 并发池
  function pLimit(concurrency = 15) {
    let activeCount = 0;
    const queue = [];

    const next = () => {
      activeCount--;
      if (queue.length) queue.shift()();
    };

    const run = (fn, resolve, reject) => {
      activeCount++;
      Promise.resolve().then(fn).then(resolve, reject).finally(next);
    };

    return (fn) =>
      new Promise((resolve, reject) => {
        const task = () => run(fn, resolve, reject);
        if (activeCount < concurrency) task();
        else queue.push(task);
      });
  }

  // 通过监听api来获取站点信息
  const stationInfoListener = () => {
    try {
      // 防止重复 patch
      if (XMLHttpRequest.prototype.__stationInfoPatched) return;
      XMLHttpRequest.prototype.__stationInfoPatched = true;

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._method = method;
        this._url = url;
        return originalOpen.call(this, method, url, ...rest);
      };

      XMLHttpRequest.prototype.send = function (body) {
        const url = this._url || "";

        // ===== STATION INFO =====
        if (url.includes(STATION_INFO_URL)) {
          // 请求阶段
          try {
            if (typeof body === "string") {
              const parsedBody = JSON.parse(body);
              stationDSPIds = parsedBody.stationIds || [];
              currentDates = parsedBody.endTime || "";
            }
          } catch (e) {
            console.warn("STATION_INFO request body parse failed", e);
          }

          // 响应阶段
          this.addEventListener("load", () => {
            let response;

            try {
              response =
                typeof this.responseText === "string"
                  ? JSON.parse(this.responseText)
                  : this.responseText;
            } catch (e) {
              console.warn("STATION_INFO response parse failed", e);
              return;
            }

            if (response?.data) {
              stationDSPInfoCache = response.data;
              currentStations = response.data?.[0]?.siteName
                ? response.data[0].siteName.slice(0, 3)
                : "";
            }
          });
        }

        // 站点dsp等内容
        if (url.includes(STATION_SUMMARY_INFO_URL)) {
          this.addEventListener("load", () => {
            let response;

            try {
              response =
                typeof this.responseText === "string"
                  ? JSON.parse(this.responseText)
                  : this.responseText;
            } catch (e) {
              console.warn("STATION_SUMMARY response parse failed", e);
              return;
            }

            if (response?.data?.length) {
              stationInfoCache = response.data[0];
            }
          });
        }

        // 中心看板
        if (url.includes(STATION_DAILY_REPORT_URL)) {
          this.addEventListener("load", () => {
            let response;
            try {
              response =
                typeof this.responseText === "string"
                  ? JSON.parse(this.responseText)
                  : this.responseText;
            } catch (e) {
              console.warn("DELIVERY_MONITORING response parse failed", e);
              return;
            }

            centerSummaryCache = response.data || null;
          });
        }

        return originalSend.call(this, body);
      };
    } catch (error) {
      console.error("站点信息监听初始化失败", error);
    }
  };

  // 生成表格图片的helper函数
  const buildAgencySummary = (
    list,
    {
      agencyKey = (item) => item.assigneeGroupName || "UNKNOWN",
      isLost = (item) => String(item.numberCode) === "2020",
      isFake = (item) => String(item.numberCode) === "2021",
    } = {},
  ) => {
    const map = new Map();

    for (const item of list) {
      const agency = String(agencyKey(item)).trim() || "UNKNOWN";
      if (!map.has(agency))
        map.set(agency, { agency, fake: 0, lost: 0, total: 0 });

      const row = map.get(agency);
      const fake = !!isFake(item);
      const lost = !!isLost(item);

      if (fake) row.fake += 1;
      if (lost) row.lost += 1;

      row.total += 1;
    }

    const rows = Array.from(map.values()).sort((a, b) => b.fake - a.fake);

    const totals = rows.reduce(
      (acc, r) => {
        acc.fake += r.fake;
        acc.lost += r.lost;
        acc.total += r.total;
        return acc;
      },
      { fake: 0, lost: 0, total: 0 },
    );

    return { rows, totals };
  };

  const downloadAgencyTablePNG = (
    { rows, totals },
    filename = "agency_table.png",
    options = {},
  ) => {
    const canvas = drawAgencyTableCanvas({ rows, totals }, options);
    canvas.toBlob(
      (blob) => {
        if (!blob) return console.error("toBlob failed");
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      "image/png",
      1,
    );
  };

  const drawAgencyTableCanvas = (
    { rows, totals },
    {
      title = null,
      THEME = {
        background: "#ffffff",

        headerBg: "#1f57b7",
        headerText: "#ffffff",

        zebraBg: "#f7f7f7",
        totalRowBg: "#eef3ff",

        text: "#111111",
        gridLine: "#d9d9d9",
        outerBorder: "#1f57b7",

        warnBg: "#fde047", // 10–20 黄色
        dangerBg: "#ef4444", // >20 红色
      },
    } = {},
  ) => {
    // 🎯 统一的区间颜色规则
    function getHighlightColor(value) {
      const n = Number(value) || 0;
      if (n > 20) return THEME.dangerBg;
      if (n >= 10) return THEME.warnBg;
      return null;
    }

    const padding = 18;
    const rowH = 40;
    const headerH = 46;
    const titleH = title ? 36 : 0;

    const font = "16px Arial";
    const headerFont = "bold 18px Arial";
    const titleFont = "bold 18px Arial";

    const cols = [
      { key: "agency", label: "Agency Of Responsibility", align: "left" },
      { key: "fake", label: "Suspected Fake POD", align: "right" },
      { key: "lost", label: "Suspected Lost", align: "right" },
      { key: "total", label: "Total", align: "right" },
    ];

    // ===== 计算列宽 =====
    const tmp = document.createElement("canvas");
    const tctx = tmp.getContext("2d");
    const valuesForMeasure = [...rows, { agency: "Total", ...totals }];

    const colWidths = cols.map((c, i) => {
      tctx.font = headerFont;
      const hw = tctx.measureText(c.label).width;
      tctx.font = font;
      const vw = Math.max(
        ...valuesForMeasure.map(
          (r) => tctx.measureText(String(r[c.key] ?? "")).width,
        ),
      );
      let w = Math.ceil(Math.max(hw, vw) + 28);
      if (i === 0) w = Math.max(w, 360);
      return w;
    });

    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const canvasW = tableW + padding * 2;
    const canvasH = padding * 2 + titleH + headerH + (rows.length + 1) * rowH;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");

    // ===== 背景 =====
    ctx.fillStyle = THEME.background;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // ===== 标题 =====
    if (title) {
      ctx.font = titleFont;
      ctx.fillStyle = THEME.text;
      ctx.textBaseline = "top";
      ctx.fillText(title, padding, padding - 2);
    }

    const x0 = padding;
    const y0 = padding + titleH;

    // ===== 表头 =====
    ctx.fillStyle = THEME.headerBg;
    ctx.fillRect(x0, y0, tableW, headerH);

    ctx.font = headerFont;
    ctx.fillStyle = THEME.headerText;
    ctx.textBaseline = "middle";

    let x = x0;
    cols.forEach((c, i) => {
      drawTextInCell(ctx, c.label, x, y0, colWidths[i], headerH, c.align);
      x += colWidths[i];
    });

    const allRows = [...rows, { agency: "Total", ...totals, __isTotal: true }];

    // ===== 表体 =====
    for (let r = 0; r < allRows.length; r++) {
      const row = allRows[r];
      const y = y0 + headerH + r * rowH;

      // 行背景
      if (row.__isTotal) {
        ctx.fillStyle = THEME.totalRowBg;
        ctx.fillRect(x0, y, tableW, rowH);
      } else if (r % 2 === 0) {
        ctx.fillStyle = THEME.zebraBg;
        ctx.fillRect(x0, y, tableW, rowH);
      }

      // 🎯 三列都参与区间高亮（Fake / Lost / Total）
      if (!row.__isTotal) {
        const columnMap = [
          { key: "fake", colIndex: 1 },
          { key: "lost", colIndex: 2 },
          { key: "total", colIndex: 3 },
        ];

        columnMap.forEach(({ key, colIndex }) => {
          const color = getHighlightColor(row[key]);
          if (color) {
            const colX =
              x0 + colWidths.slice(0, colIndex).reduce((a, b) => a + b, 0);
            ctx.fillStyle = color;
            ctx.fillRect(colX, y, colWidths[colIndex], rowH);
          }
        });
      }

      // ===== 文字 & 网格线 =====
      let cx = x0;
      cols.forEach((c, i) => {
        const w = colWidths[i];
        ctx.font = row.__isTotal ? "bold 16px Arial" : "16px Arial";
        ctx.fillStyle = THEME.text;
        ctx.textBaseline = "middle";

        drawTextInCell(ctx, String(row[c.key] ?? ""), cx, y, w, rowH, c.align);

        ctx.strokeStyle = THEME.gridLine;
        ctx.beginPath();
        ctx.moveTo(cx + w, y);
        ctx.lineTo(cx + w, y + rowH);
        ctx.stroke();

        cx += w;
      });

      ctx.beginPath();
      ctx.moveTo(x0, y + rowH);
      ctx.lineTo(x0 + tableW, y + rowH);
      ctx.stroke();
    }

    // ===== 外边框 =====
    ctx.strokeStyle = THEME.outerBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, tableW, headerH + allRows.length * rowH);

    return canvas;
  };

  const drawTextInCell = (ctx, text, x, y, w, h, align, pad = 12) => {
    const maxW = w - pad * 2;
    const clipped = clipText(ctx, text, maxW);

    ctx.textAlign = align === "right" ? "right" : "left";
    const tx = align === "right" ? x + w - pad : x + pad;
    const ty = y + h / 2;
    ctx.fillText(clipped, tx, ty);
  };

  const clipText = (ctx, text, maxWidth) => {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ell = "…";
    let s = text;
    while (s.length && ctx.measureText(s + ell).width > maxWidth) {
      s = s.slice(0, -1);
    }
    return s + ell;
  };

  // 早报的helper
  const getCurrentHeadStation = () => {
    return new Promise((resolve, reject) => {
      TOKEN = localStorage.getItem("Admin-Token");
      if (!TOKEN) {
        reject(new Error("❌ 未找到 Admin-Token"));
        return;
      }

      const xhr = new XMLHttpRequest();
      const url = `${location.origin}${CURRENT_STATIONS_URL}`;

      xhr.open("GET", url, true);

      xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
      xhr.setRequestHeader("Authorization", `Bearer ${TOKEN}`);
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      xhr.setRequestHeader("lang", "zh");
      xhr.setRequestHeader("timeZone", "GMT-0600");
      xhr.setRequestHeader("Date-Time-Format", "MM/dd/yyyy HH:mm:ss");
      xhr.setRequestHeader("User-Time-Zone", "America/Chicago");

      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;

        const text = xhr.responseText || "";

        if (xhr.status !== 200) {
          reject(new Error(`HTTP ${xhr.status}: ${text.slice(0, 200)}`));
          return;
        }

        if (text.trim().startsWith("<")) {
          reject(new Error("返回 HTML，可能登录失效或被拦截"));
          return;
        }

        try {
          const json = JSON.parse(text);
          const headNode = Array.isArray(json?.data) ? json.data[0] : null;
          const headStationGroupId = headNode?.groupId ?? null;

          if (!headStationGroupId) {
            reject(new Error("未找到 data[0].groupId"));
            return;
          }

          resolve({ headStationGroupId, headNode, raw: json });
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${e.message}`));
        }
      };

      xhr.onerror = function () {
        reject(new Error("网络错误，activeGroupTree 请求失败"));
      };

      xhr.send(null);
    });
  };

  const generateOnShelveAndOffShelveAmount = async () => {
    const { endTime } = getCurrentDates();

    TOKEN = localStorage.getItem("Admin-Token");
    if (!TOKEN) {
      console.error("❌ 未找到 Admin-Token");
      throw new Error("No token");
    }

    const { headStationGroupId } = await getCurrentHeadStation();

    const url = location.origin + ON_SHELVES_AND_OFF_SHELVES_URL;

    const datePart = String(endTime).split(" ")[0];
    const body = {
      centerIds: [headStationGroupId],
      startTime: `${datePart} 00:00:00`,
      endTime: endTime,
    };

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);

      xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
      xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
      xhr.setRequestHeader("Authorization", `Bearer ${TOKEN}`);
      xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
      xhr.setRequestHeader("lang", "zh");
      xhr.setRequestHeader("timeZone", "GMT-0600");
      xhr.setRequestHeader("Date-Time-Format", "MM/dd/yyyy HH:mm:ss");
      xhr.setRequestHeader("User-Time-Zone", "America/Chicago");

      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;

        const text = xhr.responseText || "";

        if (xhr.status !== 200) {
          reject(new Error(`HTTP ${xhr.status}: ${text.slice(0, 200)}`));
          return;
        }

        if (text.trim().startsWith("<")) {
          reject(new Error("返回 HTML，可能登录失效或被拦截"));
          return;
        }

        try {
          const json = JSON.parse(text);
          const payload = Array.isArray(json?.data)
            ? json.data[0]
            : json?.data || {};

          const {
            offShelvesCnt = 0,
            onShelvesCnt = 0,
            returnCenterCnt = 0,
          } = payload;

          const result = {
            offShelvesCnt,
            onShelvesCnt,
            returnCenterCnt,
          };
          resolve(result);
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${e.message}`));
        }
      };

      xhr.onerror = function () {
        reject(new Error("网络错误"));
      };

      xhr.send(JSON.stringify(body));
    });
  };

  // 生成excel 表格 helper
  function formatDateTime(ms) {
    if (!ms || Number.isNaN(Number(ms))) return "";
    const d = new Date(Number(ms));
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function mapToRow(item) {
    const i18n = item?.detail?.i18nFields || item?.i18nFields || {};
    return {
      "waybill number": item?.waybillNo ?? "",
      "Problem parcel type": i18n?.numberCodeI18nName ?? "",
      "Deadline for Processing": formatDateTime(item?.assigneeDeadline),
      "Agency Of Responsibility":
        item?.detail?.dutyGroupName ?? item?.assigneeGroupName ?? "",
      "Person in charge":
        item?.detail?.dutyUserName ?? item?.assigneeName ?? "",
    };
  }
  // 设置excel表格cell的宽度
  function autoFitColumns(ws, rows, header) {
    const colWidths = header.map((key) => {
      let maxLen = key.length;

      for (const row of rows) {
        const cell = row[key];
        if (cell == null) continue;

        // 中文算2个字符宽度
        const len = String(cell)
          .split("")
          .reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);

        if (len > maxLen) maxLen = len;
      }

      return { wch: Math.min(maxLen + 5, 60) }; // +2 padding，最大60防止超大
    });

    ws["!cols"] = colWidths;
  }

  // ************  核心函数  ************/
  // 生成早报
//  const generateDSPDailyMorningReport = async () => {
//    const { endTime } = getCurrentDates();
//    const { offShelvesCnt, onShelvesCnt } =
//      await generateOnShelveAndOffShelveAmount();

//    if (!centerSummaryCache) {
//      alert("未检测到中心看板数据，请前往站点看板");
//      return;
//    }
//    const sections = [];
//    const addSection = (title, lines = [], condition = true) => {
//      if (!condition) return;

//      const body = Array.isArray(lines)
//        ? lines.filter(Boolean).join("\n")
//        : String(lines || "");
//      const block = `${title}\n${body}`.trim();
//      sections.push(block);
//    };
//    const buildNumberedText = (blocks) =>
//      blocks
//        .filter(Boolean)
//        .map((block, idx) => `${idx + 1}.${block}`)
//        .join("\n\n");

//    try {
//      addSection("站点取件情况", [
//        `- 总运单量：${centerSummaryCache?.pickUpCnt ?? 0}`,
//        `- 总实收量：${centerSummaryCache?.checkOutPieces ?? 0}`,
//        `- 总取件率：${centerSummaryCache?.pickUpRate ?? 0} %`,
//      ]);

//      addSection("DSP取件效率情况", []);
//      if (currentStations !== "DFW") {
//        addSection("卡车到达情况：", ["- 正常"]);
//      }

//      addSection("站点断更抽查：", ["- 抽查了"]);

//      addSection("上下架数量", [
//        `- 上架：${onShelvesCnt}件`,
//        `- 下架：${offShelvesCnt}件   达成率 100%`,
//      ]);

//      addSection("现场取件情况", []);

//      let text = `📅 ${endTime.slice(0, 10)} ${currentStations} 早报\n\n`;
//      text += buildNumberedText(sections);

//      copyToClipboard(text);
//      alert("早报已生成并复制到剪贴板！");
//    } catch (error) {
//      console.error("早报生成失败:", error);
//      alert("早报生成失败：" + (error?.message || String(error)));
//    }
//  };
  const generateDSPDailyMorningReport = async () => {
    const { endTime } = getCurrentDates();
    const { offShelvesCnt, onShelvesCnt } =
      await generateOnShelveAndOffShelveAmount();

    if (!centerSummaryCache) {
      alert("未检测到中心看板数据，请前往站点看板");
      return;
    }

    const sections = [];

    const addSection = (title, lines = [], condition = true) => {
      if (!condition) return;

      const body = Array.isArray(lines)
        ? lines.filter(Boolean).join("\n")
        : String(lines || "");
      const block = `${title}\n${body}`.trim();
      sections.push(block);
    };

    const buildNumberedText = (blocks) =>
      blocks
        .filter(Boolean)
        .map((block, idx) => `${idx + 1}.${block}`)
        .join("\n\n");

    try {
      addSection("站点取件情况", [
        `- 总运单量：${centerSummaryCache?.pickUpCnt ?? 0}`,
        `- 总实收量：${centerSummaryCache?.checkOutPieces ?? 0}`,
        `- 总取件率：${centerSummaryCache?.pickUpRate ?? 0} %`,
        `- 取件完成时间：10点之前所有DSP均取货完成离场`,
//        `- 是否有领取异常（HUB漏发/DSP漏领 / DSP迟到 / 领件效率低）: 无`,
      ]);

      addSection("极端天气反馈", [
        `- 当日天气：无`,
        `https://acnjh1thgeif.feishu.cn/share/base/form/shrcnBgLRS8jseNE9mD0fI2SiCf`,
      ]);

      addSection(
        "卡车到达情况：",
        [
          `- 正常`,
//          `https://acnjh1thgeif.feishu.cn/wiki/DnmGwD4M6i6jnvk8Kf0cwWScnA0?renamingWikiNode=false&sheet=S7ANir`,
        ],
        currentStations !== "DFW",
      );

      addSection("站点断更抽查：", [
        `- 抽查线路：`,
        `- 抽查结果：正常`,
      ]);

//      addSection("上下架数量", [
//        `- 上架：${onShelvesCnt}/${onShelvesCnt}件    达成率 100%`,
//        `- 下架：${offShelvesCnt}/${offShelvesCnt}件   达成率 100%`,
//      ]);

      addSection("DSP违规操作记录", [
        `- 违规现象：无`,
        `https://acnjh1thgeif.feishu.cn/wiki/ABgRwCa0bit5FLkEVWXcKVmmnbc?table=tblT9gNtWYDSmFhU&view=vewzWA8hB9`,
      ]);

      addSection("现场取件情况", []);

      let text = `📅 ${endTime.slice(0, 10)}${currentStations ? `  ${currentStations}` : ""} 早报\n\n`;
      text += buildNumberedText(sections);

      copyToClipboard(text);
      alert("早报已生成并复制到剪贴板！");
    } catch (error) {
      console.error("早报生成失败:", error);
      alert("早报生成失败：" + (error?.message || String(error)));
    }
  };

  // dsp列表截图
  function captureMorningReportScreenshot() {
    executeCapture();
    function executeCapture() {
      console.log(" 开始截图流程...");

      // 选择目标元素
      const originalTarget = document.querySelector(".left-content");
      if (!originalTarget) {
        console.warn("未找到 class='left-content' 元素");
        return;
      }

      // 锁定原始宽度
      const originalWidth = originalTarget.offsetWidth;

      // 创建克隆节点
      const cloneTarget = originalTarget.cloneNode(true);

      cloneTarget.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: ${originalWidth}px !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        z-index: -9999;
        background-color: #ffffff;
        visibility: visible;
    `;

      const nestedScrollables = cloneTarget.querySelectorAll("*");
      nestedScrollables.forEach((el) => {
        el.style.overflow = "visible";
        el.style.maxHeight = "none";
      });

      document.body.appendChild(cloneTarget);

      // 截图配置
      const options = {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#ffffff",
        width: originalWidth,
        height: cloneTarget.scrollHeight,
        windowHeight: cloneTarget.scrollHeight + 100,
        scrollY: 0,
        x: 0,
        y: 0,
      };

      // 6️执行截图
      html2canvas(cloneTarget, options)
        .then((canvas) => {
          const link = document.createElement("a");
          link.href = canvas.toDataURL("image/png");
          link.download = `早报截图_${new Date().getTime()}.png`;
          link.click();
          alert("截图成功！");
        })
        .catch((err) => {
          alert("截图失败: " + err.message);
        })
        .finally(() => {
          document.body.removeChild(cloneTarget);
        });
    }
  }

  // 生成晚报
  const generateDSPDailyEveningReport = () => {
    // 检测是否成功获取
    if (stationInfoCache === null) {
      alert(
        "⚠️ 未检测到站点数据，请确认页面加载完成。请前往派送报表->当天日期->展开",
      );
      return;
    }

    try {
      let text = `📅 ${currentDates} ${currentStations} 晚报\n`;
      text += `
应派件：${stationInfoCache.checkOutPieces}
已妥投：${stationInfoCache.podPieces}
退回站点：${stationInfoCache.returnCenter}
已重派：${stationInfoCache.reassigned}
派送失败：${stationInfoCache.deliveryFailPieces}
派送中：${stationInfoCache.deliveringPieces}
妥投率：${calculatePodRate(
        stationInfoCache.checkOutPieces,
        stationInfoCache.podPieces,
        stationInfoCache.reassigned,
      )}% \n
`;

//      text += "各DSP派送表现：\n";

//      stationDSPInfoCache.forEach((dsp) => {
//        text +=
//          `${dsp.siteName.padEnd(8, " ")}：` +
//          `${dsp.podPieces}/${dsp.checkOutPieces}，` +
//          `妥投率${calculatePodRate(
//            dsp.checkOutPieces,
//            dsp.podPieces,
//            dsp.reassigned,
//          )}%，` +
//          `派送中${dsp.deliveringPieces}，` +
//          `失败${dsp.deliveryFailPieces}，` +
//          `重派${dsp.reassigned}\n`;
//      });

//        text += "\n各DSP派送表现："; //新增

      copyToClipboard(text);
      alert("晚报已生成并复制到剪贴板！");
    } catch (error) {
      alert("晚报生成失败", error);
    } finally {
      return;
    }
  };


  // 生成Performance
  // 生成 Performance 表格图片
  const generateDSPPerformanceTable = () => {
    if (!Array.isArray(stationDSPInfoCache) || stationDSPInfoCache.length === 0) {
      alert("⚠️ 未检测到DSP数据，请前往派送报表 -> 当天日期 -> 展开");
      return;
    }

    const rows = stationDSPInfoCache
      .map((dsp) => {
        const outOfDelivery = Number(dsp.deliveringPieces ?? 0);
        const deliveryFail = Number(dsp.deliveryFailPieces ?? 0);

        const rate2400 = calculatePodRate(
          Number(dsp.checkOutPieces ?? 0),
          Number(dsp.podPieces ?? 0),
          Number(dsp.reassigned ?? 0),
        );

        return {
          dsp: dsp.siteName ?? "",
          outOfDelivery,
          deliveryFail,
          rate2400,
        };
      })
      .sort((a, b) => b.rate2400 - a.rate2400)
      .map((row, index) => ({
        ...row,
        rank: index + 1,
      }));

    const totals = rows.reduce(
      (acc, row) => {
        acc.outOfDelivery += row.outOfDelivery;
        acc.deliveryFail += row.deliveryFail;
        return acc;
      },
      {
        dsp: "总计",
        outOfDelivery: 0,
        deliveryFail: 0,
        rate2400: 0,
        rank: "",
      },
    );

    totals.rate2400 = calculatePodRate(
      Number(stationInfoCache?.checkOutPieces ?? 0),
      Number(stationInfoCache?.podPieces ?? 0),
      Number(stationInfoCache?.reassigned ?? 0),
    );

    const canvas = drawDSPPerformanceCanvas(rows, totals);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          alert("Performance 表格生成失败");
          return;
        }

        const today = new Date();
        const ymd = `${today.getFullYear()}-${String(
          today.getMonth() + 1,
        ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `DSP_Performance_${ymd}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
      "image/png",
      1,
    );
  };

  // 绘制 Performance 表格
  const drawDSPPerformanceCanvas = (rows, totals) => {
    const scale = 2;

    const colWidths = [170, 210, 220, 220, 130];
    const rowH = 58;
    const headerH = 58;

    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const tableH = headerH + (rows.length + 1) * rowH;

    const canvas = document.createElement("canvas");
    canvas.width = tableW * scale;
    canvas.height = tableH * scale;

    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    const headers = ["DSP", "Out of delivery", "Delivery fail", "2400", "Rank"];

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, tableW, tableH);

    ctx.fillStyle = "#9fc2e3";
    ctx.fillRect(0, 0, tableW, headerH);

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;

    let x = 0;

    headers.forEach((header, index) => {
      ctx.strokeRect(x, 0, colWidths[index], headerH);

      ctx.font = "bold 28px Arial";
      ctx.fillStyle = "#000000";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(header, x + colWidths[index] / 2, headerH / 2);

      x += colWidths[index];
    });

    const allRows = [...rows, totals];

    allRows.forEach((row, rowIndex) => {
      const y = headerH + rowIndex * rowH;
      const isTotal = rowIndex === allRows.length - 1;

      const values = [
        row.dsp,
        row.outOfDelivery,
        row.deliveryFail,
        `${Number(row.rate2400).toFixed(2)}%`,
        row.rank,
      ];

      let cx = 0;

      values.forEach((value, colIndex) => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(cx, y, colWidths[colIndex], rowH);

        ctx.strokeStyle = "#000000";
        ctx.strokeRect(cx, y, colWidths[colIndex], rowH);

        if (isTotal) {
          ctx.font = "bold 28px Arial";
        } else if (colIndex === 0) {
          ctx.font = "bold 28px Arial";
        } else {
          ctx.font = "28px Arial";
        }

//        let textColor = "#000000";

//        if (!isTotal && colIndex === 1 && Number(row.outOfDelivery) > 0) {
//          textColor = "#ff0000";
//        }

//        if (!isTotal && colIndex === 2 && Number(row.deliveryFail) >= 30) {
//          textColor = "#ff0000";
//      }
          let textColor = "#000000";

          // 非总计行才进行颜色判断
          if (!isTotal) {

          // out of delivery > 10 红色
          if (colIndex === 1 && Number(row.outOfDelivery) > 10) {
          textColor = "#ff0000";
          }

          // delivery fail > 30 红色
          if (colIndex === 2 && Number(row.deliveryFail) > 30) {
          textColor = "#ff0000";
          }

          // 2400 < 97 红色
          if (colIndex === 3 && Number(row.rate2400) < 97) {
          textColor = "#ff0000";
          }
      }
        
      ctx.fillStyle = textColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(value), cx + colWidths[colIndex] / 2, y + rowH / 2);

      cx += colWidths[colIndex];
      });
    });

    return canvas;
  };

  // 生成小红花
  const generateDSPYesterdayPerformanceSummary = async () => {
    if (
      !Array.isArray(stationDSPInfoCache) ||
      stationDSPInfoCache.length === 0
    ) {
      alert(
        "⚠️ 未检测到站点数据，请确认页面加载完成。请前往派送报表->前一天日期->展开",
      );
      return;
    }

    try {
      let passedDSPs = [];
      let failedDSPs = [];
      let totalPerformance = 0;
      stationDSPInfoCache.forEach((dsp) => {
        const successRate = calculatePodRate(
          dsp.checkOutPieces ?? 0,
          dsp.podPieces ?? 0,
          dsp.reassigned ?? 0,
        );
        totalPerformance += successRate;
        const item = { ...dsp, successRate };
        (successRate >= 98 ? passedDSPs : failedDSPs).push(item);
      });

      passedDSPs.sort((a, b) => b.successRate - a.successRate);
      failedDSPs.sort((a, b) => b.successRate - a.successRate);

      const awards = Array.isArray(AWARD_EMOJI_FOR_DSP_PERFORMANCE)
        ? AWARD_EMOJI_FOR_DSP_PERFORMANCE
        : [];

      let text = `📅 ${currentDates ?? ""} ${currentStations ?? ""}\nDSP Performance ${Math.round((totalPerformance / stationDSPInfoCache.length + Number.EPSILON) * 100) / 100}%\n\n`;
      text += `Compliant DSP：\n`;

      passedDSPs.forEach((dsp, index) => {
        text += `${String(dsp.siteName ?? "").padEnd(8, " ")}: ${dsp.successRate}%\t${index + 1} ${
          index < awards.length ? awards[index] : ""
        }\n`;
      });

      if (failedDSPs.length > 0) {
        text += `\nNon-Compliant DSP：\n`;
        failedDSPs.forEach((dsp, index) => {
          text += `${String(dsp.siteName ?? "").padEnd(8, " ")}: ${dsp.successRate}%\t${
            passedDSPs.length + index + 1
          }\n`;
        });
      }

      copyToClipboard(text);
      alert("小红花文本已生成并复制到剪贴板！");
      if (!workspaceDataCache || workspaceDataCache.length === 0) {
        alert(
          "⚠️ 未检测到工作台数据，无法生成小红花表格。请先点击【获取FakePOD和疑似丢失数据】按钮请求数据。记得切换右上角到对应站点",
        );
        return;
      }
      await generateSuspectLostAndFakePodsTable();
      alert("表格已生成并下载！");
    } catch (error) {
      console.error("小红花生成失败", error);
    }
  };

  // 获取并下载Fake pod 和 疑似丢失 dsp总量表格
  const generateSuspectLostAndFakePodsTable = async () => {
    try {
      if (
        !Array.isArray(workspaceDataCache) ||
        workspaceDataCache.length === 0
      ) {
        alert("⚠️ 未检测到数据，请刷新后重试");
        return;
      }

      // 1) 聚合统计（按 Agency）
      const { rows, totals } = buildAgencySummary(workspaceDataCache, {
        agencyKey: (item) => item.detail.dutyGroupName || "UNKNOWN",
        // suspected lost
        isLost: (item) =>
          String(item.numberCode) === "2020" ||
          item.unusualCode === "US-SUSPECTED-LOSS",
        // fake pod
        isFake: (item) =>
          String(item.numberCode) === "2021" ||
          item.unusualCode === "US-FAKE-POD",
      });

      // 2) 下载 PNG
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(
        today.getMonth() + 1,
      ).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

      downloadAgencyTablePNG(
        { rows, totals },
        `Suspect_Lost_FakePOD_${ymd}.png`,
        {
          title: `Suspected Lost & Fake POD (${ymd})`,
          highlightTopN: 3,
          highlightMaxFake: true,
        },
      );
    } catch (error) {
      console.error("❌ 生成表格失败:", error);
      alert("❌ 生成表格失败，请看控制台错误信息");
    } finally {
      return;
    }
  };

  // 获取并下载Fake pod 和 疑似丢失 excel表格 （早上的表格）
  const generateSuspectLostAndFakePodsDetailTable = (
    filename = `Suspect_Lost_FakePOD_${new Date().toISOString().split("T")[0]}.xlsx`,
  ) => {
    if (workspaceDataCache.length === 0) {
      alert("没有数据可导出");
      return;
    }
    if (typeof XLSX === "undefined") {
      alert("XLSX 未加载成功，请检查 @require");
      return;
    }

    const rows = workspaceDataCache.map(mapToRow);

    const ws = XLSX.utils.json_to_sheet(rows, {
      header: [
        "waybill number",
        "Problem parcel type",
        "Deadline for Processing",
        "Agency Of Responsibility",
        "Person in charge",
      ],
      skipHeader: false,
    });

    ws["!autofilter"] = { ref: "A1:E1" };

    ws["!cols"] = [
      { wch: 18 },
      { wch: 14 },
      { wch: 20 },
      { wch: 12 },
      { wch: 18 },
    ];

    const headerStyle = {
      font: { bold: true, color: { rgb: "000000" } },
      fill: { patternType: "solid", fgColor: { rgb: "BFBFBF" } },
      alignment: { horizontal: "center", vertical: "center" },
    };

    const cellStyle = {
      alignment: { vertical: "center" },
    };

    const range = XLSX.utils.decode_range(ws["!ref"]);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      if (ws[addr]) ws[addr].s = headerStyle;
    }
    for (let r = 1; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (ws[addr]) ws[addr].s = cellStyle;
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Abnormal");

    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const url = URL.createObjectURL(blob);

    if (typeof GM_download === "function") {
      GM_download({ url, name: filename });
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
    }

    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  // ************  UI 部分  ************/
  const toolkitButtons = [];
  let toolbarEl = null;
  let toggleBtnEl = null;

  function createToolbar() {
    if (toolbarEl) return toolbarEl;

    const el = document.createElement("div");
    el.id = "tm-toolkit-toolbar";

    // 工具栏整体固定位置
    el.style.position = "fixed";
    el.style.top = "120px";
    el.style.right = "15px";
    el.style.zIndex = "9999";

    // ⭐ 自动排队（关键）
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.gap = "8px"; // 按钮间距

    document.body.appendChild(el);
    toolbarEl = el;
    return el;
  }

  function createButton(text, handler, color) {
    // 确保工具栏存在
    const toolbar = createToolbar();

    const btn = document.createElement("button");
    btn.textContent = text;

    // 按钮样式
    btn.style.padding = "6px";
    btn.style.background = color;
    btn.style.color = "white";
    btn.style.border = "none";
    btn.style.borderRadius = "6px";
    btn.style.cursor = "pointer";
    btn.style.width = "90px";
    btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";
    btn.style.fontSize = "13px";
    btn.style.lineHeight = "1.2";

    btn.style.userSelect = "none";

    if (typeof handler === "function") {
      btn.addEventListener("click", async () => {
        try {
          await handler();
        } catch (e) {
          console.error(`[${text}] handler error:`, e);
          alert(`${text} 执行失败，详情看 console`);
        }
      });
    } else {
      console.warn(`[${text}] click handler is not a function:`, handler);
      btn.addEventListener("click", () =>
        alert(`${text} handler 未定义/未加载`),
      );
    }

    toolbar.appendChild(btn);

    toolkitButtons.push(btn);
    return btn;
  }

  function createToggleButton() {
    if (toggleBtnEl) return toggleBtnEl;

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "隐藏";

    toggleBtn.style.position = "fixed";
    toggleBtn.style.top = "80px";
    toggleBtn.style.right = "15px";
    toggleBtn.style.padding = "6px";
    toggleBtn.style.background = "#343a40";
    toggleBtn.style.color = "white";
    toggleBtn.style.border = "none";
    toggleBtn.style.borderRadius = "6px";
    toggleBtn.style.cursor = "pointer";
    toggleBtn.style.zIndex = "9999";
    toggleBtn.style.width = "90px";
    toggleBtn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";
    toggleBtn.style.fontSize = "13px";

    let visible = true;

    toggleBtn.addEventListener("click", () => {
      visible = !visible;

      if (toolbarEl) {
        toolbarEl.style.display = visible ? "flex" : "none";
      }

      toggleBtn.textContent = visible ? "隐藏" : "显示";
    });

    document.body.appendChild(toggleBtn);
    toggleBtnEl = toggleBtn;
    return toggleBtn;
  }

  function initToolkit() {
    createToolbar();
    createToggleButton();

    createButton(
      "使用教程",
      async () => {
        try {
          alert(`
早报截图: 用于获取派送监控，派送视图的长图， 点击即可\n
获取工作台数据: 用于获取两天内 FakePod 和 Suspect Lost 的数据，耗时比较长，点击后请耐心等待，直到看到提示数据已缓存\n
早报：切换右上角到对应站点，站点看板 -> 派送报表 -> 当天日期 -> 展开\n
晚报：站点看板 -> 派送报表 -> 当天日期 -> 展开\n
小红花：需要先点击【获取工作台数据】， 站点看板 -> 派送报表 -> 前一天日期\n
工作台excel表格： 需要先点击【获取工作台数据】， 点击即可`);
        } catch (e) {
          console.error(e);
          alert("完蛋，教不会了");
        }
      },
      "rgb(209, 32, 32)",
    );

    createButton("早报", generateDSPDailyMorningReport, "rgb(54, 151, 151)");

    createButton(
      "早报截图",
      captureMorningReportScreenshot,
      "rgb(255, 11, 161)",
    );

    createButton("晚报", generateDSPDailyEveningReport, "rgb(65, 143, 189)");

    // Performance Bar
    createButton(
      "Performance",
      generateDSPPerformanceTable,
      "rgb(80, 120, 180)",
    );

    createButton("小红花", generateDSPYesterdayPerformanceSummary, "#96567dff");

    createButton(
      "工作台excel表格",
      generateSuspectLostAndFakePodsDetailTable,
      "rgb(46, 96, 109)",
    );

    createButton(
      "获取工作台数据",
      async () => {
        try {
          alert("开始请求数据，可能需要一些时间，请耐心等待...");
          const data = await getSuspectLostAndFakePods();
          workspaceDataCache = data;
          alert("已缓存工作台数据");
        } catch (e) {
          console.error(e);
          alert("请求失败: " + (e?.message || e));
        }
      },
      "rgb(152, 230, 213)",
    );
  }

  // 用于监听更新的site信息
  stationInfoListener();
  setTimeout(initToolkit, 3000);
})();
