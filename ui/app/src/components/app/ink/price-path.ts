type Point = { x: number; y: number };
type Pen = Pick<CanvasRenderingContext2D, "moveTo" | "bezierCurveTo">;

/** Shape-preserving interpolation: round corners without adding price extrema.
 * The latest sample remains the endpoint; this introduces no feed delay. */
export function tracePricePath(pen: Pen, samples: readonly Point[]) {
  const points: Point[] = [];
  for (const point of samples) {
    const previous = points.at(-1);
    if (!previous || point.x > previous.x) points.push(point);
    else if (point.x === previous.x) points[points.length - 1] = point;
  }
  if (!points.length) return;
  pen.moveTo(points[0].x, points[0].y);
  if (points.length === 1) return;
  const slopes = new Float64Array(points.length - 1);
  const tangents = new Float64Array(points.length);
  for (let i = 0; i < slopes.length; i++) slopes[i] = (points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x);
  tangents[0] = slopes[0];
  tangents[points.length - 1] = slopes[slopes.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const left = slopes[i - 1], right = slopes[i];
    // Flats and turning points stay exact. Harmonic means resist steep spikes.
    tangents[i] = left * right > 0 ? 2 / (1 / left + 1 / right) : 0;
  }
  for (let i = 0; i < slopes.length; i++) {
    if (!slopes[i]) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const sum = (tangents[i] + tangents[i + 1]) / slopes[i];
    // Ordered control points keep every segment inside its observed price band.
    if (sum > 3) { tangents[i] *= 3 / sum; tangents[i + 1] *= 3 / sum; }
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], third = (b.x - a.x) / 3;
    pen.bezierCurveTo(a.x + third, a.y + tangents[i] * third, b.x - third, b.y - tangents[i + 1] * third, b.x, b.y);
  }
}
