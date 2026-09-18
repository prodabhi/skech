import { ScenarioPanel } from "./scenario-panel";
import { SectionScene } from "./illo";
import story from "./story.module.css";
import styles from "./worked-example.module.css";

export function WorkedExample() {
  return (
    <section aria-labelledby="worked-example-title" className={story.chapter} data-story-section="" id="worked-example">
      <div className={styles.card} data-story-card="">
        <div className={styles.heading}>
          <div>
            <h2 id="worked-example-title">Say you draw this one on Bitcoin.</h2>
            <p>You draw the path. Watch the price take its own.</p>
          </div>
          <SectionScene name="example" className={styles.art} />
        </div>
        <ScenarioPanel />
      </div>
    </section>
  );
}
