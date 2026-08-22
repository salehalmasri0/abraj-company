# بوابة الموظفين — Backend

البنية: Cloudflare Worker + D1 + Twilio Verify. لا تُخزّن الأرقام الوطنية أو الرواتب داخل GitHub.

## 1) إنشاء قاعدة D1

أنشئ قاعدة باسم `abraj-employees` ثم نفّذ:

```bash
npx wrangler d1 execute abraj-employees --remote --file=employee-api/schema.sql
```

ضع `database_id` الناتج في `employee-api/wrangler.toml`.

## 2) الأسرار

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_VERIFY_SERVICE_SID
```

يجب أن يكون `SESSION_SECRET` قيمة عشوائية طويلة. لا تُضع هذه القيم في GitHub أو ملفات الموقع.

## 3) نشر الـ API

```bash
cd employee-api
npx wrangler deploy
```

اربط النطاق `api.horses2002.com` بالـ Worker. البوابة تستخدم هذا العنوان تلقائيًا.

## 4) إضافة الموظفين

أضف الموظفين من بيئة إدارية موثوقة/SQL، وليس من واجهة عامة. مثال:

```sql
INSERT INTO employees(national_id,employee_number,full_name,phone_e164,department,job_title)
VALUES('NATIONAL_ID','EMP001','اسم الموظف','+9627XXXXXXXX','الموارد البشرية','موظف');

INSERT INTO salaries(employee_id,month,basic_salary,allowances,deductions,net_salary,pdf_url)
VALUES(1,'2026-08',500,50,25,525,NULL);

INSERT INTO attendance(employee_id,work_date,check_in,check_out,status)
VALUES(1,'2026-08-22','08:00','16:00','present');
```

استبدل البيانات التجريبية ببياناتك الفعلية من نظام الموارد البشرية.

## 5) كشف الراتب PDF

يمكن وضع رابط PDF خاص في `pdf_url`، لكن لا تستخدم رابطًا عامًا. الأفضل لاحقًا ربط R2/خدمة تخزين خاصة وإصدار روابط مؤقتة بعد التحقق من الجلسة.

## 6) الحماية

- جلسة HttpOnly/Secure لمدة 30 دقيقة.
- OTP عبر Twilio Verify.
- لا يعاد الرقم الوطني أو الهاتف الكامل للواجهة.
- لا تُعاد بيانات موظف إلا للجلسة المرتبطة بمعرّف الموظف.
- حد أقصى 3 طلبات OTP لكل رقم خلال 10 دقائق.
- البوابة `noindex,nofollow`.

## 7) النشر التلقائي للواجهة

ملف `portal/employee-portal.html` هو المصدر، وWorkflow ينشره إلى `employee-portal.html` في الجذر حتى يبقى رابط الموقع الحالي ثابتًا.
