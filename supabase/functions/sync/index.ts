import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as cheerio from "https://esm.sh/cheerio@1";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function freshToken() {
  const res = await fetch("https://launchpad.37signals.com/authorization/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      type: "refresh",
      refresh_token: Deno.env.get("BC_REFRESH_TOKEN")!,
      client_id: Deno.env.get("BC_CLIENT_ID")!,
      client_secret: Deno.env.get("BC_CLIENT_SECRET")!,
    }),
  }).then(r => r.json());
  return res.access_token as string;
}

const UA = Deno.env.get("PULSE_USER_AGENT")!;
const account = Deno.env.get("BC_ACCOUNT_ID")!;

serve(async (req) => {
  const access = await freshToken();

  const bc = async (path: string) =>
    fetch(`https://3.basecampapi.com/${account}${path}`, {
      headers: { Authorization: `Bearer ${access}`, "User-Agent": UA },
    }).then(r => r.json());

  // 1. list projects
  const projects = await bc("/projects.json");

  for (const p of projects) {
    await supabase.from("projects").upsert({ id: p.id, name: p.name });

    // 2. questionnaire id from dock
    const dock = await bc(`/projects/${p.id}.json`);
    const qUrl = dock.dock.find((d: any) => d.name === "questionnaire")?.url;
    if (!qUrl) continue;
    const qnId = /questionnaires\/(\d+)/.exec(qUrl)?.[1];
    if (!qnId) continue;

    const questions = await bc(
      `/buckets/${p.id}/questionnaires/${qnId}/questions.json`,
    );

    for (const q of questions) {
      await supabase.from("questions")
        .upsert({ id: q.id, project_id: p.id, questionnaire_id: qnId, prompt: q.subject });

      // answers may be paginated
      let page = 1;
      while (true) {
        const ans = await bc(
          `/buckets/${p.id}/questions/${q.id}/answers.json?page=${page}`,
        );
        if (!ans.length) break;

        const rows = ans.map((a: any) => {
          const $ = cheerio.load(a.content);
          return {
            id: a.id,
            project_id: p.id,
            question_id: q.id,
            person_id: a.creator.id,
            content_html: a.content,
            content_text: $.text(),
            answered_at: a.created_at,
            updated_at: a.updated_at,
          };
        });

        const peopleRows = ans.map((a: any) => ({
          id: a.creator.id,
          name: a.creator.name,
          avatar_url: a.creator.avatar_url,
        }));
        await supabase.from("people").upsert(peopleRows, { ignoreDuplicates: true });

        // answers upsert
        await supabase.from("answers").upsert(rows);

        page++;
      }
    }
  }

  return new Response("ok", { status: 200 });
});
