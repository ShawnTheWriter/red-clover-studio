// Regression test for the Character-Arc-Beat scene-heading bug: Final Draft
// nests a plain <Paragraph>...</Paragraph> inside
// <SceneProperties><SceneArcBeats><CharacterArcBeat> for any scene with an arc
// beat tagged on it. The paragraph-matching regex in parseFDX is non-greedy,
// so on an arc-tagged scene it used to stop at that NESTED </Paragraph>
// instead of the Scene Heading's own closing tag — the real heading <Text>
// (always after </SceneProperties>) landed outside the match, the captured
// text came out empty, and the heading was silently dropped as a spacer.
//
// Caught on Fashion Heist S1E1 v2's real script: two Scene Headings vanished
// from the scene list, both (and only) the ones carrying a CharacterArcBeat.
// This fixture reproduces that exact XML shape rather than re-reading the
// real .fdx, so the regression stays covered even if the real file changes.

import { parseFDX } from "../shared/screenplay.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`✗ FAIL: ${name}`);
};

// One scene heading with a single-beat CharacterArcBeat (nested Paragraph),
// one with three beats, one with an empty self-closing <SceneArcBeats/> (the
// unaffected case — must keep working), interleaved with ordinary content so
// a fix that just special-cases "first paragraph" wouldn't pass.
const FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="4">
  <Content>
    <Paragraph Type="Action">
      <Text>Fade in:</Text>
    </Paragraph>
    <Paragraph Type="Scene Heading">
      <SceneProperties Length="6/8" Page="1" Title="">
        <SceneArcBeats>
          <CharacterArcBeat Name="OVERLOCK">
            <Paragraph Alignment="Left" FirstIndent="0.00">
              <Text Style=""></Text>
            </Paragraph>
          </CharacterArcBeat>
        </SceneArcBeats>
      </SceneProperties>
      <Text>INT. a secret workshop - day</Text>
    </Paragraph>
    <Paragraph Type="Action">
      <Text>Dingy, ratty dressmaker's dummy.</Text>
    </Paragraph>
    <Paragraph Type="Scene Heading">
      <SceneProperties Length="1 1/8" Page="1" Title="">
        <SceneArcBeats>
          <CharacterArcBeat Name="JACK">
            <Paragraph Alignment="Left" FirstIndent="0.00">
              <Text Style=""></Text>
            </Paragraph>
          </CharacterArcBeat>
          <CharacterArcBeat Name="OVERLOCK">
            <Paragraph Alignment="Left" FirstIndent="0.00">
              <Text Style=""></Text>
            </Paragraph>
          </CharacterArcBeat>
          <CharacterArcBeat Name="SERGE">
            <Paragraph Alignment="Left" FirstIndent="0.00">
              <Text Style=""></Text>
            </Paragraph>
          </CharacterArcBeat>
        </SceneArcBeats>
      </SceneProperties>
      <Text>INT. Overlock's Hut - night</Text>
    </Paragraph>
    <Paragraph Type="Action">
      <Text>Jack drags Serge from the bed.</Text>
    </Paragraph>
    <Paragraph Type="Scene Heading">
      <SceneProperties Length="2/8" Page="2" Title="">
        <SceneArcBeats/>
      </SceneProperties>
      <Text>EXT. village - night</Text>
    </Paragraph>
    <Paragraph Type="Action">
      <Text>Overlock runs in the rain.</Text>
    </Paragraph>
  </Content>
</FinalDraft>`;

const parsed = parseFDX(FIXTURE);

check("all 4 scenes present (1 pre-slugline + 3 real)", parsed.scenes.length === 4);
check("scene 2 heading = arc-tagged workshop, not dropped", parsed.scenes[1]?.heading === "INT. A Secret Workshop - DAY");
check("scene 3 heading = 3-beat-arc-tagged hut, not dropped", parsed.scenes[2]?.heading === "INT. Overlock'S Hut - NIGHT");
check("scene 4 heading = unaffected empty-arc scene still works", parsed.scenes[3]?.heading === "EXT. Village - NIGHT");
check("no scene heading text is empty", parsed.scenes.slice(1).every((s) => s.heading && s.heading !== "(no slugline)"));

console.log(`\n${fail ? "✗" : "✓"} screenplay: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
