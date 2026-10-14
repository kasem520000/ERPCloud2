#!/usr/bin/env bash
# ===========================================================================
# `pnpm start:erp:local` — تشغيل نظام ERP كاملاً على الجهاز بأمرٍ واحد، بلا Docker.
#
#   scripts/local-start.sh [خيارات]
#
#   --dev          الواجهات في وضع التطوير (`next dev`) بدل الإنتاج (`next start`)
#   --no-build     تخطّي البناء (استعمل آخر مخرجٍ مبنيّ)
#   --no-seed      تخطّي الترحيل والبذرة
#   --with-db      إقلاع PostgreSQL المحلي (`pnpm db:local`) إن كان المنفذ 5432 مغلقاً
#   --force        إيقاف ما يشغل منافذ النظام قبل البدء (وإلا يُرفض البناء مع خادمٍ يعمل)
#   --stop         إيقاف كل ما شغّله هذا السكربت
#   --status       عرض المنافذ وحالة كل خدمة (HTTP) ثم الخروج
#   -h | --help    هذه الرسالة
#
# ما يفعله بالترتيب:
#   1. يقرأ `.env` من جذر المستودع ويُصدّر متغيّراته.
#   2. يتحقّق من الأدوات والمنافذ (ويحترم قاعدة المستودع: لا `next build` مع خادم dev يعمل).
#   3. يثبّت الاعتماديات إن لزم، ويبني الحزم المشتركة والـAPI والواجهات.
#   4. يطبّق الترحيلات والبذرة (مرّةً واحدة، بـ`--no-seed` تُتخطّى).
#   5. يقلع الخدمات الخمس: API (3000) · worker · staff (3001) · marketing (3002) ·
#      platform-admin (3003)، ويُسجّل السجلّات في `logs/`.
#   6. ينتظر الجهوزية ويطبع جدول الروابط وحالة كل خدمة.
#
# مثال: `pnpm start:erp:local --with-db` على جهازٍ جديد (يُقلع القاعدة ثم البقية).
# ===========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOGS="$ROOT/logs"
mkdir -p "$LOGS"

MODE="prod"; DO_BUILD=1; DO_SEED=1; WITH_DB=0; FORCE=0
ACTION="start"

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --no-build) DO_BUILD=0 ;;
    --no-seed) DO_SEED=0 ;;
    --with-db) WITH_DB=1 ;;
    --force) FORCE=1 ;;
    --stop) ACTION="stop" ;;
    --status) ACTION="status" ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "خيارٌ غير معروف: $arg (جرّب --help)" >&2; exit 2 ;;
  esac
done

# --- .env -------------------------------------------------------------------
if [[ ! -f "$ROOT/.env" ]]; then
  echo "✗ لا يوجد .env — شغّل أولاً: pnpm env:setup" >&2
  exit 1
fi
# القراءة بمُحلِّل التطبيق نفسه (`scripts/dotenv.mjs` عبر `scripts/env-exports.mjs`): `.env`
# يحمل مفاتيح PEM بـ`\n` حرفية في سطرٍ واحد، وقراءةٌ ساذجة تُبقيها سطراً واحداً فيفشل توقيع
# الجلسات (`asn1 encoding routines::header too long`) ويظهر الخطأ كأنه «فشل تسجيل دخول».
eval "$(node "$ROOT/scripts/env-exports.mjs")"

API_PORT="${PORT:-3000}"
STAFF_PORT="${STAFF_PORT:-3001}"
MARKETING_PORT="${MARKETING_PORT:-3002}"
ADMIN_PORT="${PLATFORM_ADMIN_PORT:-3003}"
DB_PORT="$(node -e "try{const u=new URL(process.env.DATABASE_URL);console.log(u.port||5432)}catch(e){console.log(5432)}")"
DB_HOST="$(node -e "try{const u=new URL(process.env.DATABASE_URL);console.log(u.hostname)}catch(e){console.log('localhost')}")"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0 || return 1; }
# إيقاف مجموعة العملية التي تشغل منفذاً (بلا اعتمادٍ على ملفّ PID).
kill_port() {
  local port="$1" pids=""
  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
  fi
  if [[ -z "$pids" ]] && command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' || true)"
  fi
  if [[ -z "$pids" ]] && command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  fi
  for pid in $pids; do
    kill -TERM "-$(ps -o pgid= "$pid" 2>/dev/null | tr -d ' ')" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
}
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$1$2" 2>/dev/null || echo "000"; }
pidfile() { echo "$LOGS/$1.pid"; }
alive() { [[ -f "$(pidfile "$1")" ]] && kill -0 "$(cat "$(pidfile "$1")")" 2>/dev/null; }

SERVICES=("api" "worker" "staff" "marketing" "platform-admin")
PORTS=(   "$API_PORT" "" "$STAFF_PORT" "$MARKETING_PORT" "$ADMIN_PORT")
PROBES=(  "/health/live" "" "/"          "/"           "/")
LABELS=(  "واجهة الـAPI" "العامل الخلفي" "تطبيق الموظفين" "الموقع التسويقي" "لوحة المنصة")

status() {
  echo "──────────────────────────────────────────────────────────────────────────────"
  printf '%-18s %-8s %-8s %s\n' "الخدمة" "المنفذ" "PID" "HTTP"
  echo "──────────────────────────────────────────────────────────────────────────────"
  for i in "${!SERVICES[@]}"; do
    local name="${SERVICES[$i]}" port="${PORTS[$i]}" probe="${PROBES[$i]}"
    local pid="—" code="—"
    if alive "$name"; then pid="$(cat "$(pidfile "$name")")"; fi
    if [[ -n "$port" ]] && port_open "$port"; then code="$(http_code "$port" "$probe")"; fi
    printf '%-18s %-8s %-8s %s\n' "${LABELS[$i]}" "${port:-—}" "$pid" "$code"
  done
  echo "──────────────────────────────────────────────────────────────────────────────"
  printf 'قاعدة البيانات   %-8s %s\n' "$DB_PORT" "$(port_open "$DB_PORT" && echo "مفتوحة ($DB_HOST)" || echo 'مغلقة ✗')"
}

if [[ "$ACTION" == "status" ]]; then status; exit 0; fi

stop_all() {
  echo "⏹  إيقاف خدمات النظام…"
  for name in "${SERVICES[@]}"; do
    local file; file="$(pidfile "$name")"
    if [[ -f "$file" ]]; then
      local pid; pid="$(cat "$file")"
      if kill -0 "$pid" 2>/dev/null; then
        # إيقاف المجموعة كاملةً (المُشغِّل + `next`/`node` الذي أطلقه).
        kill -TERM "-$(ps -o pgid= "$pid" | tr -d ' ')" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
        echo "   ✓ $name (pid $pid)"
      fi
      rm -f "$file"
    fi
  done
  # شبكة أمان: عمليةٌ بلا ملفّ PID (أو ملفٌّ تالف) تُقتل بما يشغل منفذها.
  for port in "$API_PORT" "$STAFF_PORT" "$MARKETING_PORT" "$ADMIN_PORT"; do
    port_open "$port" && { kill_port "$port"; sleep 1; }
  done
  echo "   (السجلّات باقية في logs/ — قاعدتك لم تُمسّ)"
}

if [[ "$ACTION" == "stop" ]]; then stop_all; exit 0; fi

# --- 1) الأدوات --------------------------------------------------------------
for tool in node pnpm curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "✗ الأداة «$tool» غير مثبّتة" >&2; exit 1; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || { echo "✗ يلزم Node ≥ 20 (الموجود $NODE_MAJOR)" >&2; exit 1; }
echo "◆ ERP — تشغيلٌ محلي ($MODE) · Node $(node -v) · pnpm $(pnpm -v)"

# --- 2) قاعدة البيانات -------------------------------------------------------
if ! port_open "$DB_PORT"; then
  if [[ "$WITH_DB" == "1" ]]; then
    echo "◆ إقلاع PostgreSQL المحلي على المنفذ $DB_PORT…"
    setsid pnpm db:local >"$LOGS/postgres.log" 2>&1 &
    echo $! > "$(pidfile postgres)"
    for _ in $(seq 1 60); do port_open "$DB_PORT" && break; sleep 1; done
    port_open "$DB_PORT" || { echo "✗ لم تُفتح القاعدة — راجع logs/postgres.log" >&2; exit 1; }
    echo "   ✓ القاعدة جاهزة"
  else
    cat >&2 <<'EOS'
✗ قاعدة البيانات مغلقة.
  شغّلها في طرفيةٍ أخرى:  pnpm db:local
  أو أعد هذا الأمر بـ:   pnpm start:erp:local --with-db
EOS
    exit 1
  fi
fi

# --- 3) المنافذ (قاعدة المستودع: لا بناء مع خادمٍ يعمل) ------------------------
busy=()
for i in "${!SERVICES[@]}"; do
  port="${PORTS[$i]}"
  [[ -z "$port" ]] && continue
  alive "${SERVICES[$i]}" && continue
  port_open "$port" && busy+=("$port")
done
if (( ${#busy[@]} > 0 )); then
  if [[ "$FORCE" == "1" ]]; then
    echo "◆ منافذ مشغولة (${busy[*]}) — أُوقف ما يشغلها (--force)…"
    for port in "${busy[@]}"; do
      kill_port "$port"
      sleep 1
    done
  else
    echo "✗ منافذ مشغولة: ${busy[*]} — أوقفها أو أعد الأمر بـ --force" >&2
    exit 1
  fi
fi

# --- 4) التثبيت والبناء ------------------------------------------------------
if [[ "$DO_BUILD" == "1" ]]; then
  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "◆ تثبيت الاعتماديات…"; pnpm install --frozen-lockfile
  fi
  # ⚠️ `.env` يضبط `NODE_ENV=development` (بيئة تطوير)، و`next build` يرفض هذا القيمة:
  #    «You are using a non-standard NODE_ENV…» ثم يسقط توليد `/404` برسالةٍ مضلّلة
  #    (`<Html> should not be imported outside of pages/_document`). لذلك تُثبَّت
  #    `NODE_ENV=production` في كل خطوة بناء.
  echo "◆ بناء الحزم المشتركة…"
  NODE_ENV=production pnpm -r --filter "./packages/*" build >"$LOGS/build-packages.log" 2>&1 \
    || { tail -20 "$LOGS/build-packages.log"; exit 1; }
  echo "◆ بناء واجهة الـAPI…"
  NODE_ENV=production pnpm --filter @erp/api build >"$LOGS/build-api.log" 2>&1 \
    || { tail -20 "$LOGS/build-api.log"; exit 1; }
  if [[ "$MODE" == "prod" ]]; then
    for app in staff marketing platform-admin; do
      echo "◆ بناء $app…"
      # `distDir` الافتراضي `.next` مطلوبٌ لـ`next start`، والبناء نقيّ في كل محاولة.
      built=0
      for attempt in 1 2; do
        rm -rf "apps/$app/.next"
        # `MARKETING_REVALIDATE_SECONDS=0`: نشرٌ محليّ للعرض ⇒ بلا ذاكرة بيانات، فيظهر
        # تعديل المشغّل في الموقع فوراً (وإلا فالنافذة الافتراضية 30 ثانية في الإنتاج).
        if ( unset NEXT_DIST_DIR; NODE_ENV=production MARKETING_REVALIDATE_SECONDS="${MARKETING_REVALIDATE_SECONDS:-0}" \
             pnpm --filter "@erp/$app" build ) >"$LOGS/build-$app.log" 2>&1; then
          built=1; break
        fi
        if [[ "$attempt" == "1" ]]; then
          # تعثّرٌ عابرٌ معروف: توليد `/404` عبر `pages/_error` يرفع
          # `<Html> should not be imported outside of pages/_document` تحت ضغط الذاكرة
          # (على جهازٍ بمعالجَين وذاكرةٍ محدودة) — والبناء الثاني ينجح.
          echo "   ↻ محاولةٌ ثانية لـ$app (تعثّرٌ عابر في مرحلة التوليد الساكن)…"
          sleep 3
        fi
      done
      if [[ "$built" != "1" ]]; then
        echo "✗ فشل بناء $app — آخر 20 سطراً من السجلّ:" >&2
        tail -20 "$LOGS/build-$app.log" >&2
        exit 1
      fi
    done
  fi
fi

# --- 5) الترحيل والبذرة ------------------------------------------------------
if [[ "$DO_SEED" == "1" ]]; then
  echo "◆ ترحيلات وبذرة…"
  pnpm db:migrate >"$LOGS/migrate.log" 2>&1 || { tail -20 "$LOGS/migrate.log"; exit 1; }
  pnpm db:seed    >"$LOGS/seed.log"    2>&1 || { tail -20 "$LOGS/seed.log"; exit 1; }
  echo "   ✓ القاعدة محدَّثة ومبذورة"
fi

# --- 6) الإقلاع --------------------------------------------------------------
start_service() { # name root_dir command...
  local name="$1"; shift
  local dir="$1"; shift
  # `setsid` **يتفرّع** إن كان المُشغِّل زعيم مجموعة، فيصير `$!` أَباً عابراً يموت فوراً
  # (ويلتبس الأمر: «الخدمة تعمل والملفّ يقول ميتة»). لذلك القشرة نفسها تكتب `$$` ثم
  # تُستبدل بالخدمة (`exec` يحفظ الـPID) — فيصير الملفّ هو زعيم المجموعة وقاتله.
  ( cd "$ROOT/$dir" && setsid bash -c 'echo "$$" > "$1"; shift; exec "$@"' _ "$(pidfile "$name")" "$@" \
      >"$LOGS/$name.log" 2>&1 & )
  sleep 0.3
}

echo "◆ إقلاع الخدمات…"
RUN_ENV="production"; [[ "$MODE" == "dev" ]] && RUN_ENV="development"
start_service api        .            env "NODE_ENV=$RUN_ENV" node apps/api/dist/main.js
start_service worker     .            env "NODE_ENV=$RUN_ENV" WORKER=1 node apps/api/dist/main.js
for pair in "staff:$STAFF_PORT" "marketing:$MARKETING_PORT" "platform-admin:$ADMIN_PORT"; do
  name="${pair%%:*}"; port="${pair##*:}"
  if [[ "$MODE" == "dev" ]]; then
    start_service "$name" . env "NODE_ENV=$RUN_ENV" "PORT=$port" node scripts/next-run.mjs "$name" dev
  else
    start_service "$name" . env "NODE_ENV=$RUN_ENV" \
      "MARKETING_REVALIDATE_SECONDS=${MARKETING_REVALIDATE_SECONDS:-0}" \
      node scripts/next-run.mjs "$name" start
  fi
done

# --- 7) انتظار الجهوزية ------------------------------------------------------
echo "◆ انتظار الجهوزية…"
for i in "${!SERVICES[@]}"; do
  port="${PORTS[$i]}"; probe="${PROBES[$i]}"
  [[ -z "$port" ]] && continue
  ok=0
  for _ in $(seq 1 45); do
    if [[ "$(http_code "$port" "$probe")" =~ ^(2|3) ]]; then ok=1; break; fi
    sleep 2
  done
  [[ "$ok" == "1" ]] && printf '   ✓ %s على المنفذ %s\n' "${LABELS[$i]}" "$port" \
                     || printf '   ⚠ %s لم يستجب بعد (راجع logs/%s.log)\n' "${LABELS[$i]}" "${SERVICES[$i]}"
done

cat <<EOF

$(status)

✅ النظام يعمل.

  🌐 الموقع التسويقي ................. http://localhost:$MARKETING_PORT
  🧾 تطبيق الموظفين (المحاسبة) ....... http://localhost:$STAFF_PORT
  🛠️  لوحة المنصة .................... http://localhost:$ADMIN_PORT
  🔌 واجهة الـAPI ................... http://localhost:$API_PORT  (الحيوية: /health/live · الجهوزية: /health/ready)
  🗄️  قاعدة البيانات ................. postgres://$DB_HOST:$DB_PORT

  حسابات العرض (كلمات المرور في .env):  $DEMO_OWNER_EMAIL · $PLATFORM_ADMIN_EMAIL
  السجلّات: logs/*.log   ·   الإيقاف: pnpm start:erp:local --stop   ·   الحالة: --status
EOF
