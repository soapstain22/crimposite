// Little guys from the game wandering around the screen like ants.
// Sprites come from art/walkers.png: one character per 144px column,
// 3 walk frames (48x56) across, rows are down / left / right / up like RPG Maker.
(function () {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var SHEET = 'art/walkers.png';
  var CHARACTERS = 28;
  var FW = 48, FH = 56;
  // crimpo and the wizard show up more than everyone else
  var FAVORITES = [0, 0, 0, 3, 3];
  var STEP_MS = 140;
  var FRAMES = [0, 1, 2, 1];

  var layer = document.createElement('div');
  layer.className = 'ants';
  document.body.appendChild(layer);

  var ants = [];
  var w = innerWidth, h = innerHeight;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function spawn() {
    var el = document.createElement('div');
    el.className = 'ant';
    var who = Math.random() < 0.3
      ? FAVORITES[Math.floor(Math.random() * FAVORITES.length)]
      : Math.floor(Math.random() * CHARACTERS);
    var ant = {
      el: el,
      who: who,
      x: rand(0, w - FW),
      y: rand(0, h - FH),
      heading: rand(0, Math.PI * 2),
      speed: rand(35, 70),
      rest: 0,
      leader: null,
      frame: 0,
      clock: rand(0, STEP_MS),
      row: 0
    };
    layer.appendChild(el);
    ants.push(ant);
  }

  function count() {
    return Math.max(8, Math.min(22, Math.round(w * h / 60000)));
  }

  function fit() {
    w = innerWidth; h = innerHeight;
    while (ants.length < count()) spawn();
    while (ants.length > count()) ants.pop().el.remove();
  }

  function think(a) {
    // sometimes stop and look around
    if (a.rest <= 0 && Math.random() < 0.004) a.rest = rand(400, 1800);
    // sometimes fall in line behind someone, like ants do
    if (!a.leader && Math.random() < 0.003) {
      var other = ants[Math.floor(Math.random() * ants.length)];
      if (other !== a && other.leader !== a) a.leader = other;
    }
    if (a.leader && Math.random() < 0.002) a.leader = null;

    if (a.leader) {
      var dx = a.leader.x - a.x, dy = a.leader.y - a.y;
      if (dx * dx + dy * dy > 40 * 40) a.heading = Math.atan2(dy, dx);
      else a.rest = Math.max(a.rest, 120);
    } else {
      a.heading += rand(-0.25, 0.25);
    }
  }

  function move(a, dt) {
    if (a.rest > 0) {
      a.rest -= dt;
      a.frame = 1;
      return;
    }
    var vx = Math.cos(a.heading), vy = Math.sin(a.heading);
    a.x += vx * a.speed * dt / 1000;
    a.y += vy * a.speed * dt / 1000;

    // turn around at the edges
    if (a.x < -8 || a.x > w - FW + 8) { a.heading = Math.PI - a.heading; a.x = Math.max(-8, Math.min(w - FW + 8, a.x)); }
    if (a.y < -8 || a.y > h - FH + 8) { a.heading = -a.heading; a.y = Math.max(-8, Math.min(h - FH + 8, a.y)); }

    vx = Math.cos(a.heading); vy = Math.sin(a.heading);
    a.row = Math.abs(vx) > Math.abs(vy) ? (vx < 0 ? 1 : 2) : (vy < 0 ? 3 : 0);

    a.clock += dt;
    if (a.clock > STEP_MS) { a.clock = 0; a.frame = (a.frame + 1) % FRAMES.length; }
  }

  function draw(a) {
    var col = a.who * 3 + FRAMES[a.frame];
    a.el.style.backgroundPosition = (-col * FW) + 'px ' + (-a.row * FH) + 'px';
    a.el.style.transform = 'translate(' + Math.round(a.x) + 'px,' + Math.round(a.y) + 'px)';
  }

  var last = 0;
  function tick(t) {
    var dt = last ? Math.min(t - last, 100) : 16;
    last = t;
    for (var i = 0; i < ants.length; i++) {
      think(ants[i]);
      move(ants[i], dt);
      draw(ants[i]);
    }
    requestAnimationFrame(tick);
  }

  var img = new Image();
  img.onload = function () {
    fit();
    addEventListener('resize', fit);
    requestAnimationFrame(tick);
  };
  img.src = SHEET;
})();
