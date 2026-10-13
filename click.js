(function () {
  var TAIL = 0.05;
  var CLEANUP = 0.05;
  var BUS_GAIN = 4;

  var cues = {
    toggle: {
      masterGain: 0.4,
      layers: [
        {
          kind: "noise",
          filterType: "bandpass",
          filterFrequency: 2200,
          filterQ: 1.6,
          attack: 0.001,
          decay: 0.016,
          peak: 0.12,
        },
        {
          kind: "noise",
          filterType: "bandpass",
          filterFrequency: 3800,
          filterQ: 1.6,
          offset: 0.024,
          attack: 0.001,
          decay: 0.02,
          peak: 0.1,
        },
      ],
    },
    pulse: {
      masterGain: 0.42,
      layers: [
        {
          kind: "noise",
          filterType: "bandpass",
          filterFrequency: 2600,
          filterQ: 2.4,
          attack: 0.001,
          decay: 0.022,
          peak: 0.08,
        },
        {
          kind: "tone",
          waveform: "triangle",
          frequency: 620,
          glideTo: 1240,
          glideTime: 0.07,
          attack: 0.002,
          decay: 0.085,
          peak: 0.055,
        },
      ],
    },
  };

  var roles = {
    ui: { cue: "toggle", volume: 0.42 },
    action: { cue: "pulse", volume: 0.48 },
  };

  var spark = {
    particles: 8,
    pixelSize: 3,
    trailSize: 2,
    distance: 12,
    trailRatio: 0.45,
    durationMs: 360,
    easing: "steps(5, end)",
    size: 36,
  };

  var interactive =
    'a, button, input, select, textarea, summary, label, img, picture, video, audio, canvas, svg, iframe, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="slider"], [contenteditable="true"], [data-sound]:not([data-sound="off"]), [tabindex]:not([tabindex="-1"])';

  var sounded =
    'a[href], button:not(:disabled), [role="button"], summary, [data-sound]';

  var master = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? 0.35
    : 0.72;
  var context = null;
  var bus = null;
  var downOnInteractive = false;

  function audioContext() {
    if (context) return context;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      context = new Ctx();
    } catch (error) {
      return null;
    }
    return context;
  }

  function outputBus(ctx) {
    if (bus) return bus;
    var gain = ctx.createGain();
    gain.gain.value = BUS_GAIN;
    var compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 6;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.08;
    gain.connect(compressor).connect(ctx.destination);
    bus = gain;
    return bus;
  }

  function playTone(ctx, dest, layer, time) {
    var osc = ctx.createOscillator();
    osc.type = layer.waveform;
    osc.frequency.setValueAtTime(layer.frequency, time);
    if (layer.glideTo !== undefined) {
      var glide = layer.glideTime ?? layer.attack + layer.decay;
      osc.frequency.exponentialRampToValueAtTime(layer.glideTo, time + glide);
    }
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(1e-4, time);
    gain.gain.exponentialRampToValueAtTime(layer.peak, time + layer.attack);
    gain.gain.exponentialRampToValueAtTime(
      1e-4,
      time + layer.attack + layer.decay
    );
    osc.connect(gain).connect(dest);
    osc.start(time);
    osc.stop(time + layer.attack + layer.decay + TAIL);
  }

  function playNoise(ctx, dest, layer, time) {
    var length = layer.attack + layer.decay + TAIL;
    var frames = Math.max(1, Math.floor(length * ctx.sampleRate));
    var buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    var source = ctx.createBufferSource();
    source.buffer = buffer;
    var filter = ctx.createBiquadFilter();
    filter.type = layer.filterType;
    filter.frequency.value = layer.filterFrequency;
    if (layer.filterQ !== undefined) filter.Q.value = layer.filterQ;
    var gain = ctx.createGain();
    gain.gain.setValueAtTime(1e-4, time);
    gain.gain.exponentialRampToValueAtTime(layer.peak, time + layer.attack);
    gain.gain.exponentialRampToValueAtTime(
      1e-4,
      time + layer.attack + layer.decay
    );
    source.connect(filter).connect(gain).connect(dest);
    source.start(time);
    source.stop(time + length);
  }

  function cueLength(cue) {
    return Math.max.apply(
      null,
      cue.layers.map(function (layer) {
        return (layer.offset || 0) + layer.attack + layer.decay + TAIL;
      })
    );
  }

  function playCue(name, volume) {
    var cue = cues[name];
    var level = master * Math.min(1, Math.max(0, volume));
    if (!cue || level === 0) return;
    var ctx = audioContext();
    if (!ctx) return;

    var start = function () {
      var now = ctx.currentTime;
      var destination = outputBus(ctx);
      var gain = ctx.createGain();
      gain.gain.value = cue.masterGain * level;
      gain.connect(destination);
      cue.layers.forEach(function (layer) {
        var at = now + (layer.offset || 0);
        if (layer.kind === "tone") playTone(ctx, gain, layer, at);
        else playNoise(ctx, gain, layer, at);
      });
      window.setTimeout(function () {
        gain.disconnect();
      }, (cueLength(cue) + CLEANUP) * 1000);
    };

    if (ctx.state === "running") start();
    else ctx.resume().then(start).catch(function () {});
  }

  function playRole(role) {
    var spec = roles[role];
    if (spec) playCue(spec.cue, spec.volume);
  }

  function elementFrom(event) {
    var target = event.target;
    if (target instanceof Element) return target;
    if (target instanceof Node) return target.parentElement;
    return null;
  }

  function isInteractive(event) {
    var node = elementFrom(event);
    return !node || Boolean(node.closest(interactive));
  }

  function soundRole(node) {
    if (node.closest('[data-sound="off"]')) return null;
    var marked = node.closest("[data-sound]");
    var value = marked && marked.getAttribute("data-sound");
    if (value === "ui" || value === "action" || value === "mark") return value;
    if (value === "off") return null;
    return "ui";
  }

  function sparkPixels() {
    var pixels = [];
    for (var i = 0; i < spark.particles; i += 1) {
      var angle = (i / spark.particles) * Math.PI * 2 - Math.PI / 2;
      var dx = Math.cos(angle);
      var dy = Math.sin(angle);
      pixels.push({
        className: "click-spark__pixel",
        size: spark.pixelSize,
        dx: Math.round(dx * spark.distance),
        dy: Math.round(dy * spark.distance),
      });
      pixels.push({
        className: "click-spark__pixel click-spark__pixel--trail",
        size: spark.trailSize,
        dx: Math.round(dx * spark.distance * spark.trailRatio),
        dy: Math.round(dy * spark.distance * spark.trailRatio),
        delayMs: 30,
      });
    }
    pixels.push({
      className: "click-spark__pixel click-spark__pixel--core",
      size: spark.pixelSize + 1,
      dx: 0,
      dy: 0,
    });
    return pixels;
  }

  function createSpark(x, y) {
    var node = document.createElement("div");
    node.className = "click-spark";
    node.setAttribute("aria-hidden", "true");
    node.style.width = spark.size + "px";
    node.style.height = spark.size + "px";
    node.style.left = x - spark.size / 2 + "px";
    node.style.top = y - spark.size / 2 + "px";
    var origin = spark.size / 2;
    sparkPixels().forEach(function (pixel) {
      var dot = document.createElement("span");
      var half = pixel.size / 2;
      dot.className = pixel.className;
      dot.style.width = pixel.size + "px";
      dot.style.height = pixel.size + "px";
      dot.style.left = Math.round(origin - half) + "px";
      dot.style.top = Math.round(origin - half) + "px";
      dot.style.setProperty("--spark-dx", pixel.dx + "px");
      dot.style.setProperty("--spark-dy", pixel.dy + "px");
      if (pixel.delayMs) {
        dot.style.setProperty("--spark-delay", pixel.delayMs + "ms");
      }
      node.appendChild(dot);
    });
    return node;
  }

  function animateSpark(node) {
    node.querySelectorAll(".click-spark__pixel").forEach(function (pixel) {
      var core = pixel.classList.contains("click-spark__pixel--core");
      var delay = Number.parseInt(
        pixel.style.getPropertyValue("--spark-delay") || "0",
        10
      );
      var options = {
        duration: spark.durationMs,
        easing: spark.easing,
        delay: delay,
        fill: "forwards",
      };
      if (core) {
        pixel.animate(
          [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 1, transform: "scale(1)", offset: 0.4 },
            { opacity: 0, transform: "scale(0)" },
          ],
          options
        );
        return;
      }
      var dx = pixel.style.getPropertyValue("--spark-dx") || "0px";
      var dy = pixel.style.getPropertyValue("--spark-dy") || "0px";
      pixel.animate(
        [
          { opacity: 1, transform: "translate(0px, 0px)" },
          { opacity: 1, transform: "translate(" + dx + ", " + dy + ")", offset: 0.6 },
          { opacity: 0, transform: "translate(" + dx + ", " + dy + ")" },
        ],
        options
      );
    });
  }

  function reducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  document.addEventListener(
    "pointerdown",
    function (event) {
      if (event.button !== 0) return;
      downOnInteractive = isInteractive(event);
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      var node = elementFrom(event);
      if (!node) return;
      var control = node.closest(sounded);
      if (!control) return;
      if (
        (control instanceof HTMLButtonElement && control.disabled) ||
        control.getAttribute("aria-disabled") === "true"
      ) {
        return;
      }
      playRole(soundRole(control));
    },
    true
  );

  document.addEventListener(
    "click",
    function (event) {
      var blocked = downOnInteractive || isInteractive(event);
      downOnInteractive = false;
      if (reducedMotion() || event.button !== 0 || blocked) return;
      playRole("ui");
      var node = createSpark(event.clientX, event.clientY);
      document.body.appendChild(node);
      animateSpark(node);
      window.setTimeout(function () {
        node.remove();
      }, spark.durationMs + 60);
    },
    true
  );
})();
