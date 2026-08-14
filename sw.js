var CACHE = "layers-v2";
var SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Network-first for the page itself so updates arrive; cache fallback keeps it
// working offline. Cache-first for static assets.
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var isNav = e.request.mode === "navigate" || e.request.destination === "document";
  if (isNav) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (m) {
          return m || caches.match("./index.html");
        });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (m) {
      return m || fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      });
    })
  );
});

// ---- reminders: the app mirrors its data into IndexedDB; this check runs on
// periodic background sync so alerts appear even when the app is closed. ----

function idb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open("layers-db", 1);
    r.onupgradeneeded = function () {
      var d = r.result;
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      if (!d.objectStoreNames.contains("fired")) d.createObjectStore("fired");
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function idbGet(store, key) {
  return idb().then(function (d) {
    return new Promise(function (res, rej) {
      var rq = d.transaction(store, "readonly").objectStore(store).get(key);
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  });
}
function idbPut(store, key, val) {
  return idb().then(function (d) {
    return new Promise(function (res, rej) {
      var tx = d.transaction(store, "readwrite");
      tx.objectStore(store).put(val, key);
      tx.oncomplete = res;
      tx.onerror = function () { rej(tx.error); };
    });
  });
}

function fmtTime(t) {
  if (!t) return "";
  var h = +t.slice(0, 2), m = t.slice(3, 5);
  var ap = h < 12 ? "am" : "pm"; h = h % 12 || 12;
  return h + (m === "00" ? "" : ":" + m) + ap;
}

function reminderTime(e) {
  var p = e.date.split("-");
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  if (e.remind === "evening-before") { d.setDate(d.getDate() - 1); d.setHours(20, 0, 0, 0); return d; }
  if (e.remind === "morning-of") { d.setHours(9, 0, 0, 0); return d; }
  return null;
}

function checkReminders() {
  return idbGet("kv", "state").then(function (state) {
    if (!state || !state.events) return;
    var now = Date.now();
    return Promise.all(state.events.map(function (e) {
      if (!e.remind || e.remind === "none") return;
      var t = reminderTime(e);
      if (!t) return;
      var ms = t.getTime();
      if (now < ms || now - ms > 36 * 60 * 60 * 1000) return;
      var key = e.id + "|" + e.remind;
      return idbGet("fired", key).then(function (hit) {
        if (hit) return;
        return idbPut("fired", key, now).then(function () {
          var when = e.remind === "evening-before" ? "due tomorrow" : "due today";
          return self.registration.showNotification(e.title, {
            body: "This is " + when + (e.allDay || !e.start ? "" : " at " + fmtTime(e.start)) + ".",
            tag: key,
            icon: "icons/icon-192.png",
            badge: "icons/icon-192.png"
          });
        });
      });
    }));
  }).catch(function () {});
}

self.addEventListener("periodicsync", function (e) {
  if (e.tag === "layers-reminders") e.waitUntil(checkReminders());
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      if (list.length) return list[0].focus();
      return self.clients.openWindow("./");
    })
  );
});
