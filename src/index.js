const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra
  }
});

const now = () => Math.floor(Date.now() / 1000);
const text = (v) => String(v ?? "").trim();

async function secret(env, name) {
  const value = env[name];
  return value && typeof value.get === "function" ? await value.get() : value;
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return atob(padded);
}

async function signSession(payload, secretValue) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${signature}`;
}

async function verifySession(token, secretValue) {
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretValue), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(b64urlDecode(signature), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecode(body));
    return payload.exp > now() ? payload : null;
  } catch {
    return null;
  }
}

function cookieValue(request, name) {
  const cookies = request.headers.get("cookie") || "";
  const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

function cookieHeader(value, maxAge) {
  return `abraj_session=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function maskPhone(phone) {
  if (!phone || phone.length < 7) return "الهاتف المسجل";
  return `${phone.slice(0, 4)}••••${phone.slice(-2)}`;
}

async function sendOtp(env, phone) {
  const sid = await secret(env, "TWILIO_VERIFY_SERVICE_SID");
  const account = await secret(env, "TWILIO_ACCOUNT_SID");
  const token = await secret(env, "TWILIO_AUTH_TOKEN");
  if (!sid || !account || !token) throw new Error("OTP configuration missing");

  const endpoint = `https://verify.twilio.com/v2/Services/${encodeURIComponent(sid)}/Verifications`;
  const body = new URLSearchParams({ To: phone, Channel: "sms" });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${account}:${token}`)}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!response.ok) throw new Error("Twilio Verify request failed");
}

async function verifyOtp(env, phone, code) {
  const sid = await secret(env, "TWILIO_VERIFY_SERVICE_SID");
  const account = await secret(env, "TWILIO_ACCOUNT_SID");
  const token = await secret(env, "TWILIO_AUTH_TOKEN");
  if (!sid || !account || !token) throw new Error("OTP configuration missing");

  const endpoint = `https://verify.twilio.com/v2/Services/${encodeURIComponent(sid)}/VerificationCheck`;
  const body = new URLSearchParams({ To: phone, Code: code });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${account}:${token}`)}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const result = await response.json().catch(() => ({}));
  return response.ok && result.status === "approved";
}

async function currentEmployee(env, request) {
  const token = cookieValue(request, "abraj_session");
  const sessionSecret = await secret(env, "SESSION_SECRET");
  if (!token || !sessionSecret) return null;
  const session = await verifySession(token, sessionSecret);
  if (!session?.sub) return null;
  return env.DB.prepare("SELECT id, employee_number, full_name, department, job_title, status FROM employees WHERE id = ? LIMIT 1")
    .bind(session.sub).first();
}

async function rateAllowed(env, nationalHash, ipHash) {
  const since = now() - 600;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM otp_attempts WHERE requested_at > ? AND (national_id_hash = ? OR ip_hash = ?)"
  ).bind(since, nationalHash, ipHash).first();
  return Number(row?.total || 0) < 5;
}

function csvCell(value) {
  const s = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${s.replace(/"/g, '""')}"`;
}

async function report(env, request, type) {
  const employee = await currentEmployee(env, request);
  if (!employee || employee.status !== "active") return json({ error: "جلسة الدخول غير صالحة أو منتهية." }, 401);

  const filenameBase = employee.employee_number || `employee-${employee.id}`;
  let rows = [];
  let filename = `${filenameBase}-report.csv`;

  if (type === "salary") {
    const salary = await env.DB.prepare(
      "SELECT month, basic_salary, allowances, deductions, net_salary FROM salaries WHERE employee_id = ? ORDER BY month DESC LIMIT 1"
    ).bind(employee.id).first();
    if (!salary) return json({ error: "لا يوجد كشف راتب مسجل حاليًا." }, 404);
    rows = [
      ["الموظف", employee.full_name],
      ["الرقم الوظيفي", employee.employee_number || ""],
      ["الشهر", salary.month],
      ["الراتب الأساسي", salary.basic_salary],
      ["البدلات", salary.allowances],
      ["الاقتطاعات", salary.deductions],
      ["صافي الراتب", salary.net_salary]
    ];
    filename = `${filenameBase}-salary-${salary.month}.csv`;
  } else {
    const attendance = await env.DB.prepare(
      "SELECT work_date, check_in, check_out, status, notes FROM attendance WHERE employee_id = ? ORDER BY work_date DESC LIMIT 31"
    ).bind(employee.id).all();
    rows = [["التاريخ", "الحضور", "الانصراف", "الحالة", "ملاحظات"], ...(attendance.results || []).map((r) => [r.work_date, r.check_in || "", r.check_out || "", r.status, r.notes || ""])];
    filename = `${filenameBase}-attendance.csv`;
  }

  const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=UTF-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") return json({ ok: true, service: "abraj-employee-portal" });

      if (url.pathname === "/api/auth/request-otp" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const nationalId = text(body.nationalId).replace(/\D/g, "");
        if (!/^\d{8,20}$/.test(nationalId)) return json({ error: "الرجاء إدخال رقم وطني صحيح." }, 400);

        const nationalHash = await sha256(nationalId);
        const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "unknown");
        if (!(await rateAllowed(env, nationalHash, ipHash))) {
          return json({ error: "تم تجاوز عدد محاولات إرسال الرمز. حاول بعد 10 دقائق." }, 429);
        }

        const employee = await env.DB.prepare(
          "SELECT id, phone_e164, status FROM employees WHERE national_id = ? LIMIT 1"
        ).bind(nationalId).first();

        if (!employee || employee.status !== "active") {
          return json({ error: "تعذر التحقق من البيانات المدخلة. تأكد من الرقم وتواصل مع الموارد البشرية عند الحاجة." }, 400);
        }

        await sendOtp(env, employee.phone_e164);
        await env.DB.prepare(
          "INSERT INTO otp_attempts(employee_id, national_id_hash, requested_at, ip_hash) VALUES (?, ?, ?, ?)"
        ).bind(employee.id, nationalHash, now(), ipHash).run();

        return json({ ok: true, maskedPhone: maskPhone(employee.phone_e164) });
      }

      if (url.pathname === "/api/auth/verify-otp" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const nationalId = text(body.nationalId).replace(/\D/g, "");
        const otp = text(body.otp).replace(/\D/g, "");
        if (!/^\d{8,20}$/.test(nationalId) || !/^\d{6}$/.test(otp)) return json({ error: "بيانات التحقق غير صحيحة." }, 400);

        const employee = await env.DB.prepare(
          "SELECT id, phone_e164, status FROM employees WHERE national_id = ? LIMIT 1"
        ).bind(nationalId).first();
        if (!employee || employee.status !== "active") return json({ error: "تعذر إتمام التحقق." }, 401);

        if (!(await verifyOtp(env, employee.phone_e164, otp))) return json({ error: "رمز التحقق غير صحيح أو منتهي." }, 401);

        const sessionSecret = await secret(env, "SESSION_SECRET");
        if (!sessionSecret) return json({ error: "إعداد الجلسة غير مكتمل." }, 503);

        const sessionToken = await signSession({ sub: employee.id, exp: now() + 1800 }, sessionSecret);
        await env.DB.prepare(
          "UPDATE otp_attempts SET verified_at = ? WHERE employee_id = ? AND verified_at IS NULL AND requested_at > ?"
        ).bind(now(), employee.id, now() - 900).run();

        return json({ ok: true }, 200, { "set-cookie": cookieHeader(sessionToken, 1800) });
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
      }

      if (url.pathname === "/api/me" && request.method === "GET") {
        const employee = await currentEmployee(env, request);
        if (!employee || employee.status !== "active") return json({ error: "جلسة الدخول غير صالحة أو منتهية." }, 401);

        const salary = await env.DB.prepare(
          "SELECT month, basic_salary, allowances, deductions, net_salary FROM salaries WHERE employee_id = ? ORDER BY month DESC LIMIT 1"
        ).bind(employee.id).first();
        const attendance = await env.DB.prepare(
          "SELECT work_date AS date, check_in AS checkIn, check_out AS checkOut, status, notes FROM attendance WHERE employee_id = ? ORDER BY work_date DESC LIMIT 31"
        ).bind(employee.id).all();

        return json({
          employee: {
            employeeNumber: employee.employee_number,
            fullName: employee.full_name,
            department: employee.department,
            jobTitle: employee.job_title
          },
          salary: salary ? {
            month: salary.month,
            basicSalary: salary.basic_salary,
            allowances: salary.allowances,
            deductions: salary.deductions,
            netSalary: salary.net_salary
          } : null,
          attendance: attendance.results || []
        });
      }

      if (url.pathname === "/api/report/salary" && request.method === "GET") return report(env, request, "salary");
      if (url.pathname === "/api/report/attendance" && request.method === "GET") return report(env, request, "attendance");

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("ABRAJ_PORTAL_ERROR", error);
      return json({ error: "حدث خطأ داخلي. حاول لاحقًا." }, 500);
    }
  }
};
