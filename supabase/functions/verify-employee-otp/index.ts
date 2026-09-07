import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': 'https://horses2002.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})
const normalize = (v: unknown) => String(v ?? '').replace(/\D/g, '')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { nationalId, otp } = await req.json()
    const nid = normalize(nationalId)
    const code = normalize(otp)
    if (!/^\d{8,20}$/.test(nid) || !/^\d{6}$/.test(code)) {
      return json({ error: 'بيانات التحقق غير صحيحة.' }, 400)
    }

    const publicClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const { data: employee, error: employeeError } = await publicClient
      .from('employees')
      .select('id, phone, status')
      .eq('national_id', nid)
      .eq('status', 'active')
      .maybeSingle()

    if (employeeError || !employee?.phone) return json({ error: 'تعذر التحقق من البيانات.' }, 401)

    // Verify the OTP through Supabase Auth. The secret key is server-side only.
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SECRET_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } },
    )

    const { data, error } = await adminClient.auth.verifyOtp({
      phone: String(employee.phone),
      token: code,
      type: 'sms',
    })

    if (error || !data.session || !data.user) return json({ error: 'رمز التحقق غير صحيح أو منتهي.' }, 401)

    // Bind the Auth user to the employee record if this is the first successful login.
    const { error: linkError } = await adminClient
      .from('employees')
      .update({ user_id: data.user.id })
      .eq('id', employee.id)
      .is('user_id', null)

    if (linkError) console.error(linkError)

    const { error: profileError } = await adminClient
      .from('profiles')
      .update({ employee_id: employee.id, full_name: data.user.user_metadata?.full_name ?? null })
      .eq('id', data.user.id)

    if (profileError) console.error(profileError)

    return json({
      ok: true,
      session: data.session,
      user: { id: data.user.id, phone: data.user.phone },
    })
  } catch (error) {
    console.error(error)
    return json({ error: 'حدث خطأ داخلي. حاول لاحقًا.' }, 500)
  }
})
