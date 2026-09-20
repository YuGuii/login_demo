// 交互式登录页 · 脚本
// 上半部分：四个角色的行为（眼球跟随、眨眼、入场、各种表情），对外是 window.Faces
// 下半部分：表单接线，对外是 window.Login，新项目一般只用这个
//
// 角色的造型、尺寸、动作曲线与时序移植自 animated-characters-login-page 原项目
// （https://github.com/guohaolian/animated-characters-login-page，Vue → 原生 JS）。

// ============================================================
// 角色行为
// ============================================================

(function () {
  var ENTRANCE_MS = 1400;   // 等最慢的入场动画跑完（黄色 1s + 0.3s 延迟）再接管 transform
  var BLINK_MS = 150;       // 单次闭眼时长
  var BLINK_MIN = 3000;     // 两次眨眼之间的间隔，3~7 秒随机
  var BLINK_RAND = 4000;
  var LOOK_MS = 800;        // 光标落进账号框后，紫色与黑色对视的时长
  var PEEK_MS = 800;        // 明文密码时紫色偷瞄一次的时长
  var SUCCESS_MS = 5500;    // 成功后视线由上方慢慢落回来的时长
  var STAGE_W = 450;        // 舞台设计宽度，用来反推 CSS 的缩放倍数（与 style.css 的 .stage 一致）

  var ORDER = ['purple', 'black', 'orange', 'yellow'];

  var login, stage, chars = {}, timers = {};
  var reduced = false, running = false;
  var pointer = null, hasEntered = false, looking = false, peeking = false;
  var successFrom = 0, successLookY = -5;

  var state = {
    typing: false,          // 光标在账号框里
    showPassword: false,    // 密码是否明文
    passwordLength: 0,
    failed: false,
    success: false
  };

  function hidingPassword() { return state.passwordLength > 0 && !state.showPassword; }
  function peekMode() { return state.passwordLength > 0 && state.showPassword; }
  function leaning() { return state.typing || hidingPassword(); }

  // ============ 样式写入（同值不重复写，省掉每帧的无效重算） ============

  function put(el, prop, val) {
    if (!el) return;
    var c = el._st || (el._st = {});
    if (c[prop] === val) return;
    c[prop] = val;
    el.style[prop] = val;
  }

  function putVar(el, name, val) {
    if (!el) return;
    var c = el._st || (el._st = {});
    if (c[name] === val) return;
    c[name] = val;
    el.style.setProperty(name, val);
  }

  function flag(el, name, on) { if (el) el.classList.toggle(name, !!on); }

  // ============ 位置计算 ============

  // CSS 把整个舞台缩放了，行内位移写的是舞台内坐标，换算屏幕距离时要除掉这个倍数
  function scale() {
    var r = stage.getBoundingClientRect();
    return r.width ? r.width / STAGE_W : 1;
  }

  // 指针还没动过时先望向表单那一侧，不至于呆看正前方
  function target() {
    if (pointer) return pointer;
    var box = login.getBoundingClientRect();
    return { x: box.right - box.width * 0.28, y: box.top + box.height * 0.45 };
  }

  // 身体中心取到 1/3 高度处：视线落在「脸」上而不是脚底
  function measure() {
    ORDER.forEach(function (k) {
      var r = chars[k].el.getBoundingClientRect();
      if (!r.width) return;
      chars[k].center = { x: r.left + r.width / 2, y: r.top + r.height / 3 };
    });
  }

  // 原项目的 calculatePosition：脸的偏移按指针距离线性取，身体侧倾最多 6 度
  function calc(center, rangeX, rangeY, minX, maxX, minY, maxY) {
    var p = target();
    var rMinX = minX == null ? -rangeX : minX, rMaxX = maxX == null ? rangeX : maxX;
    var rMinY = minY == null ? -rangeY : minY, rMaxY = maxY == null ? rangeY : maxY;
    var dx = p.x - center.x, dy = p.y - center.y;
    var sx = Math.max(Math.abs(rMinX), Math.abs(rMaxX));
    var sy = Math.max(Math.abs(rMinY), Math.abs(rMaxY));
    return {
      faceX: Math.max(rMinX, Math.min(rMaxX, dx / (300 / sx))),
      faceY: Math.max(rMinY, Math.min(rMaxY, dy / (300 / sy))),
      skew: Math.max(-6, Math.min(6, -dx / 120))
    };
  }

  // 瞳孔朝指针偏，最多 max 像素。基准位置用「当前矩形减掉已施加的位移」反推，
  // 免得读到自己刚挪过的位置、越算越飘。
  function aim(p, forced) {
    if (forced) return { x: forced.x, y: forced.y };
    var s = scale() || 1;
    var r = p.el.getBoundingClientRect();
    var t = target();
    var dx = (t.x - (r.left + r.width / 2 - p.x * s)) / s;
    var dy = (t.y - (r.top + r.height / 2 - p.y * s)) / s;
    var dist = Math.min(Math.sqrt(dx * dx + dy * dy), p.max);
    var a = Math.atan2(dy, dx);
    return { x: Math.cos(a) * dist, y: Math.sin(a) * dist };
  }

  function eyesTo(c, forced, sad) {
    c.pupils.forEach(function (p) {
      var g = aim(p, forced);
      p.x = g.x;
      p.y = sad ? -1 : g.y;
      put(p.el, 'transform', 'translate(' + p.x.toFixed(2) + 'px,' + p.y.toFixed(2) + 'px)');
    });
  }

  function forcedLook(who) {
    if (state.success) return { x: 0, y: successLookY };
    if (peekMode()) {
      if (who === 'purple') return peeking ? { x: 4, y: 5 } : { x: -4, y: -4 };
      return { x: who === 'black' ? -4 : -5, y: -4 };
    }
    if (looking) {
      if (who === 'purple') return { x: 3, y: 4 };
      if (who === 'black') return { x: 0, y: -4 };
    }
    return null;
  }

  // ============ 每帧渲染 ============

  function paint() {
    var vis = peekMode(), lean = leaning();
    var skewOf = function (v) { return 'skewX(' + v.toFixed(2) + 'deg)'; };

    // ---- 紫色：最高的那个。光标进账号框时整体探出去（长高 40px + 侧倾 12 度 + 右移 40px） ----
    var c = chars.purple, p = c.pos;
    if (hasEntered) {
      put(c.el, 'transform', vis ? 'skewX(0deg)'
        : lean ? skewOf(p.skew - 12) + ' translateX(40px)'
        : skewOf(p.skew));
    }
    put(c.el, 'height', lean ? '440px' : '400px');
    put(c.eyes, 'left', (vis ? 50 : looking ? 85 : 75 + p.faceX) + 'px');
    put(c.eyes, 'top', (vis ? 20 : looking ? 50 : 25 + p.faceY) + 'px');
    put(c.mouth, 'left', (vis ? 72 : looking ? 106 : 97 + p.faceX) + 'px');
    put(c.mouth, 'top', (vis ? 57 : looking ? 82 : 57 + p.faceY) + 'px');
    // 身体歪了嘴也会跟着歪，这里反向抵消回来
    putVar(c.mouth, '--counter-skew', lean ? skewOf(-(p.skew - 12)) : 'skewX(0deg)');
    mouthState(c.mouth, lean);
    eyesTo(c, forcedLook('purple'), false);

    // ---- 黑色：打字时跟紫色对视，侧倾幅度是常态的 1.5 倍 ----
    c = chars.black; p = c.pos;
    if (hasEntered) {
      put(c.el, 'transform', vis ? 'skewX(0deg)'
        : looking ? skewOf(p.skew * 1.5 + 10) + ' translateX(20px)'
        : lean ? skewOf(p.skew * 1.5)
        : skewOf(p.skew));
    }
    put(c.eyes, 'left', (vis ? 10 : looking ? 32 : 26 + p.faceX) + 'px');
    put(c.eyes, 'top', (vis ? 28 : looking ? 12 : 32 + p.faceY) + 'px');
    c.lids.forEach(function (el) { flag(el, 'sad', state.failed); });
    eyesTo(c, forcedLook('black'), state.failed);

    // ---- 橙色 ----
    c = chars.orange; p = c.pos;
    if (hasEntered) put(c.el, 'transform', vis ? 'skewX(0deg)' : skewOf(p.skew));
    put(c.eyes, 'left', (vis ? 80 : 112 + p.faceX) + 'px');
    put(c.eyes, 'top', (vis ? 55 : 60 + p.faceY) + 'px');
    put(c.mouth, 'left', (vis ? 94 : 126 + p.faceX) + 'px');
    put(c.mouth, 'top', (vis ? 87 : 92 + p.faceY) + 'px');
    mouthState(c.mouth, lean);
    eyesTo(c, forcedLook('orange'), false);

    // ---- 黄色 ----
    c = chars.yellow; p = c.pos;
    if (hasEntered) put(c.el, 'transform', vis ? 'skewX(0deg)' : skewOf(p.skew));
    put(c.eyes, 'left', (vis ? 20 : 52 + p.faceX) + 'px');
    put(c.eyes, 'top', (vis ? 35 : 40 + p.faceY) + 'px');
    put(c.mouth, 'left', (vis ? 10 : 40 + p.faceX) + 'px');
    put(c.mouth, 'top', (vis ? 88 : 88 + p.faceY) + 'px');
    flag(c.path, 'wavy', state.failed);
    flag(c.path, 'happy', state.success);
    eyesTo(c, forcedLook('yellow'), false);

    // 眨眼
    ORDER.forEach(function (k) {
      chars[k].lids.forEach(function (el) { flag(el, 'blink', chars[k].blinking); });
    });
  }

  function mouthState(el, lean) {
    flag(el, 'typing', lean && !state.failed && !state.success);
    flag(el, 'sad', state.failed);
    flag(el, 'happy', state.success);
  }

  function tick() {
    if (hasEntered) {
      chars.purple.pos = calc(chars.purple.center, 0, 0, -46, 18, -8, 5);
      chars.black.pos = calc(chars.black.center, 15, 10);
      chars.orange.pos = calc(chars.orange.center, 0, 0, -46, 20, -18, 20);
      chars.yellow.pos = calc(chars.yellow.center, 15, 10);
    }
    if (state.success) {
      // ease-in-out cubic：视线从头顶慢慢落回正前方
      var t = Math.min((Date.now() - successFrom) / SUCCESS_MS, 1);
      var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      successLookY = -5 + 9 * e;
    }
    paint();
  }

  function loop() {
    if (!login || login.classList.contains('hidden')) { running = false; return; }
    tick();
    requestAnimationFrame(loop);
  }

  function start() {
    if (running || !login || login.classList.contains('hidden')) return;
    running = true;
    requestAnimationFrame(loop);
  }

  // ============ 时序：眨眼、对视、偷瞄 ============

  function scheduleBlink(key) {
    clearTimeout(timers['blink_' + key]);
    timers['blink_' + key] = setTimeout(function () {
      chars[key].blinking = true;
      start();
      timers['blinkoff_' + key] = setTimeout(function () {
        chars[key].blinking = false;
        scheduleBlink(key);
      }, BLINK_MS);
    }, BLINK_MIN + Math.random() * BLINK_RAND);
  }

  // 明文密码期间，紫色每隔 2~5 秒偷瞄一次，瞄完再排下一次
  function schedulePeek() {
    clearTimeout(timers.peek);
    clearTimeout(timers.peekOff);
    if (!peekMode()) { peeking = false; return; }
    timers.peek = setTimeout(function () {
      if (!peekMode()) { peeking = false; return; }
      peeking = true;
      timers.peekOff = setTimeout(function () {
        peeking = false;
        schedulePeek();
      }, PEEK_MS);
    }, 2000 + Math.random() * 3000);
  }

  // ============ 对外接口 ============

  function set(patch) {
    var wasTyping = state.typing, wasVis = peekMode();
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) state[k] = patch[k];
    }
    if (patch.typing !== undefined && patch.typing !== wasTyping) {
      clearTimeout(timers.look);
      looking = !!patch.typing;
      if (looking) timers.look = setTimeout(function () { looking = false; }, LOOK_MS);
    }
    if (peekMode() !== wasVis) schedulePeek();
    start();
  }

  function fail() {
    state.failed = true;
    state.success = false;
    clearTimeout(timers.fail);
    timers.fail = setTimeout(function () { state.failed = false; }, 3000);
    start();
  }

  function succeed() {
    state.success = true;
    state.failed = false;
    state.typing = false;
    looking = false;
    successFrom = Date.now();
    successLookY = -5;
    celebrate();
    start();
  }

  function reset() {
    state.typing = state.showPassword = state.failed = state.success = false;
    state.passwordLength = 0;
    looking = peeking = false;
    successLookY = -5;
    ['look', 'fail', 'peek', 'peekOff'].forEach(function (k) { clearTimeout(timers[k]); });
  }

  // 重放入场：摘掉 .entered 让 CSS 动画重新跑，1.4 秒后再接管行内 transform
  function enter() {
    if (!login || !stage) return;
    reset();
    hasEntered = false;
    ORDER.forEach(function (k) {
      var c = chars[k];
      c.el.classList.remove('entered');
      c.el.style.removeProperty('transform');
      if (c._st) delete c._st.transform;
      if (c.el._st) delete c.el._st.transform;
    });
    void stage.offsetWidth;
    clearTimeout(timers.enter);
    if (reduced) settle();
    else timers.enter = setTimeout(settle, ENTRANCE_MS);
    measure();
    start();
  }

  function settle() {
    hasEntered = true;
    ORDER.forEach(function (k) { chars[k].el.classList.add('entered'); });
    measure();
  }

  function celebrate() {
    if (reduced) return;
    var colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#A78BFA', '#FF9B6B', '#6BCB77', '#4D96FF'];
    var box = document.createElement('div');
    box.className = 'confetti-layer';
    for (var i = 0; i < 180; i++) {
      var bit = document.createElement('i');
      bit.style.left = (Math.random() * 100) + '%';
      bit.style.top = '-' + (10 + Math.random() * 30) + '%';
      bit.style.background = colors[i % colors.length];
      bit.style.width = (4 + Math.random() * 6) + 'px';
      bit.style.height = (8 + Math.random() * 12) + 'px';
      // 比原项目稍紧一点：这边两秒多就要切到列表，不能让大半彩纸还没出场
      bit.style.animationDelay = (Math.random() * 1.2) + 's';
      bit.style.animationDuration = (4.2 + Math.random() * 1.2) + 's';
      bit.style.transform = 'rotate(' + Math.round(Math.random() * 360) + 'deg)';
      box.appendChild(bit);
    }
    document.body.appendChild(box);
    // 挂在 body 上，切到列表页后剩下的彩纸还能继续落完
    clearTimeout(timers.confetti);
    timers.confetti = setTimeout(function () { box.remove(); }, 7000);
  }

  // ============ 初始化 ============

  function init() {
    login = document.getElementById('login');
    stage = document.getElementById('stage');
    if (!login || !stage) return;

    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) { reduced = false; }

    Array.prototype.forEach.call(stage.querySelectorAll('.character'), function (el) {
      var key = el.dataset.char;
      var c = {
        el: el,
        eyes: el.querySelector('.eyes'),
        mouth: el.querySelector('.mouth') || el.querySelector('.yellow-mouth'),
        path: el.querySelector('.yellow-mouth-path'),
        lids: [],
        pupils: [],
        blinking: false,
        center: { x: 0, y: 0 },
        pos: { faceX: 0, faceY: 0, skew: 0 }
      };
      // 有眼白的角色，眼白负责眨眼、里面的瞳孔负责转；只有瞳孔的角色两件事都归它
      var balls = el.querySelectorAll('.eyeball');
      if (balls.length) {
        Array.prototype.forEach.call(balls, function (ball) {
          c.lids.push(ball);
          c.pupils.push({ el: ball.querySelector('.pupil'), max: key === 'purple' ? 5 : 4, x: 0, y: 0 });
        });
      } else {
        Array.prototype.forEach.call(el.querySelectorAll('.dot'), function (dot) {
          c.lids.push(dot);
          c.pupils.push({ el: dot, max: 5, x: 0, y: 0 });
        });
      }
      chars[key] = c;
    });

    if (ORDER.some(function (k) { return !chars[k]; })) return;

    measure();
    ORDER.forEach(scheduleBlink);

    // 两种事件都收：个别环境里只派发其中一种，只挂一个会出现「先点一下才跟随」
    var onPointer = function (e) { pointer = { x: e.clientX, y: e.clientY }; start(); };
    window.addEventListener('pointermove', onPointer, { passive: true, capture: true });
    window.addEventListener('mousemove', onPointer, { passive: true, capture: true });
    window.addEventListener('resize', function () { measure(); start(); });
    window.addEventListener('scroll', function () { measure(); start(); }, { passive: true });
  }

  window.Faces = {
    enter: enter,
    set: set,
    fail: fail,
    succeed: succeed,
    reset: reset,
    remeasure: function () { measure(); start(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// ============================================================
// 表单接线：把输入框状态喂给角色，把提交交给调用方的 onSubmit。
// 用法见 README.md；只依赖下面这几个 id，改 id 就传 ids 覆盖。
// ============================================================

(function () {
  var opt = {
    onSubmit: null,          // function(账号, 密码) -> Promise<true | false | {ok, message}>
    onDone: null,            // 登录成功、页面淡出之后调用，通常在这里显示你自己的主界面
    successDelay: 2200,      // 成功后停留多久再淡出：够看清笑脸和彩纸
    fadeMs: 400,             // 淡出时长，与 CSS 里 #login 的 transition 对齐
    autoFocus: false,        // 默认不自动聚焦：光标一落进账号框紫色就会探头，留给用户自己点
    ids: {
      login: 'login', stage: 'stage', form: 'login-form',
      user: 'username', pass: 'password', toggle: 'pw-toggle',
      error: 'login-error', button: 'login-btn'
    }
  };

  function $(key) { return document.getElementById(opt.ids[key]); }

  function faces(fn) { if (window.Faces) fn(window.Faces); }

  function setError(msg) {
    var el = $('error');
    if (el) el.textContent = msg || '';
  }

  function shake() {
    var box = document.querySelector('.login-form-inner');
    if (!box) return;
    // 重放动画：先摘类、强制回流、再加回去
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
  }

  function togglePassword() {
    var input = $('pass'), btn = $('toggle');
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.classList.toggle('on', show);
    btn.title = btn.ariaLabel = show ? '隐藏密码' : '显示密码';
    input.focus();
    faces(function (f) { f.set({ showPassword: show }); });
  }

  function fail(msg) {
    faces(function (f) { f.fail(); });
    setError(msg || '账号或密码不正确');
    shake();
  }

  function succeed() {
    setError('');
    faces(function (f) { f.succeed(); });
    setTimeout(function () {
      var login = $('login');
      login.classList.add('fading');
      setTimeout(function () {
        login.classList.add('hidden');
        login.classList.remove('fading');
        if (opt.onDone) opt.onDone();
      }, opt.fadeMs);
    }, opt.successDelay);
  }

  function submit(e) {
    e.preventDefault();
    if (!opt.onSubmit) { fail('还没接 onSubmit'); return; }

    var btn = $('button');
    var user = $('user').value.trim();
    var pass = $('pass').value;
    setError('');
    if (btn) btn.disabled = true;

    Promise.resolve(opt.onSubmit(user, pass)).then(function (res) {
      if (btn) btn.disabled = false;
      // 允许三种返回：true / false / {ok, message}
      if (res === true || (res && res.ok)) { $('pass').value = ''; succeed(); return; }
      fail(res && res.message);
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      fail((err && err.message) || '网络异常，请重试');
    });
  }

  function bind() {
    var form = $('form');
    if (!form) return;
    form.addEventListener('submit', submit);
    if ($('toggle')) $('toggle').addEventListener('click', togglePassword);

    // 账号框拿到光标 → 紫色探头、和黑色对视一下
    $('user').addEventListener('focus', function () { faces(function (f) { f.set({ typing: true }); }); });
    $('user').addEventListener('blur', function () { faces(function (f) { f.set({ typing: false }); }); });
    // 密码框只看长度：够一位，四个角色就都别过身去
    $('pass').addEventListener('input', function () {
      var len = $('pass').value.length;
      faces(function (f) { f.set({ passwordLength: len }); });
    });
  }

  window.Login = {
    init: function (options) {
      options = options || {};
      for (var k in options) {
        if (k === 'ids') { for (var i in options.ids) opt.ids[i] = options.ids[i]; }
        else opt[k] = options[k];
      }
      var self = this;
      var go = function () { bind(); self.show(); };
      // 上面的角色模块要等 DOMContentLoaded 才初始化；页面还在解析时就调 show()
      // 会拿到空引用、入场动画放不出来，所以这里同样等一拍。
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
      else go();
      return this;
    },

    // 显示登录页并重放入场动画（display:none 时 CSS 动画不跑，所以要在显示之后调）
    show: function () {
      var login = $('login');
      if (!login) return;
      $('pass').value = '';
      setError('');
      login.classList.remove('hidden', 'fading');
      faces(function (f) { f.enter(); });
      if (opt.autoFocus) setTimeout(function () { $('user').focus(); }, 30);
    },

    hide: function () {
      var login = $('login');
      if (login) login.classList.add('hidden');
    },

    // 手动触发表情，方便你在别的时机复用：'fail' / 'succeed' / 'reset'
    faces: function (name) {
      faces(function (f) { if (f[name]) f[name](); });
    }
  };
})();
