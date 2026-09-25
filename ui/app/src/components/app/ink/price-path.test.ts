import { expect, test } from "bun:test";
import { tracePricePath } from "./price-path";

function path(points: { x: number; y: number }[]) {
  let start: number[] = [];
  const curves: number[][] = [];
  tracePricePath({ moveTo: (x, y) => { start = [x, y]; }, bezierCurveTo: (...args) => { curves.push(args); } }, points);
  return { start, curves };
}

test("smoothed prices retain every extremum and current endpoint without overshoot", () => {
  const samples = [{x:0,y:100},{x:1,y:100},{x:2,y:10},{x:6,y:80},{x:7,y:82},{x:9,y:20},{x:12,y:20}];
  const { start, curves } = path(samples);
  expect(start).toEqual([0,100]);
  expect(curves.length).toBe(samples.length - 1);
  for (let i = 0; i < curves.length; i++) {
    const [x1,y1,x2,y2,x,y] = curves[i], a = samples[i], b = samples[i+1];
    expect([x,y]).toEqual([b.x,b.y]);
    expect(x1).toBeGreaterThan(a.x); expect(x2).toBeLessThan(b.x);
    for (const v of [y1,y2]) { expect(v).toBeGreaterThanOrEqual(Math.min(a.y,b.y)); expect(v).toBeLessThanOrEqual(Math.max(a.y,b.y)); }
    let previous = a.y;
    for (let n=1;n<=100;n++) {
      const t=n/100,u=1-t,value=u*u*u*a.y+3*u*u*t*y1+3*u*t*t*y2+t*t*t*b.y;
      expect(value).toBeGreaterThanOrEqual(Math.min(a.y,b.y)-1e-9);
      expect(value).toBeLessThanOrEqual(Math.max(a.y,b.y)+1e-9);
      expect((value-previous)*Math.sign(b.y-a.y)).toBeGreaterThanOrEqual(-1e-9);
      previous=value;
    }
  }
});

test("duplicate timestamps use the latest price and never create invalid controls", () => {
  const result = path([{x:0,y:1},{x:0,y:2},{x:1,y:3},{x:1,y:4},{x:2,y:4}]);
  expect(result.start).toEqual([0,2]);
  expect(result.curves).toHaveLength(2);
  expect(result.curves.flat().every(Number.isFinite)).toBe(true);
  expect(result.curves[0].slice(-2)).toEqual([1,4]);
  expect(path([])).toEqual({start:[],curves:[]});
  expect(path([{x:1,y:2}])).toEqual({start:[1,2],curves:[]});
});
