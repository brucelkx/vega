import Subflow from './Subflow';
import {Transform, tupleid} from 'vega-dataflow';
import {fastmap, hasOwnProperty, inherits} from 'vega-util';

/**
 * Facets a dataflow into a set of subflows based on a key.
 * @constructor
 * @param {object} params - The parameters for this operator.
 * @param {function(Dataflow, string): Operator} params.subflow - A function
 *   that generates a subflow of operators and returns its root operator.
 * @param {function(object): *} params.key - The key field to facet by.
 */
export default function Facet(params) {
  Transform.call(this, {}, params);
  this._keys = fastmap(); // cache previously calculated key values

  // keep track of active subflows, use as targets array for listeners
  // this allows us to limit propagation to only updated subflows
  const a = this._targets = [];
  a.active = 0;
  a.forEach = f => {
    for (let i=0, n=a.active; i<n; ++i) {
      f(a[i], i, a);
    }
  };
}

inherits(Facet, Transform, {
  activate(flow) {
    this._targets[this._targets.active++] = flow;
  },

  // parent argument provided by PreFacet subclass
  subflow(key, flow, pulse, parent) {
    const flows = this.value;
    let sf = hasOwnProperty(flows, key) && flows[key];
    let df;
    let p;

    if (!sf) {
      p = parent || (p = this._group[key]) && p.tuple;
      df = pulse.dataflow;
      sf = new Subflow(pulse.fork(pulse.NO_SOURCE), this);
      df.add(sf).connect(flow(df, key, p));
      flows[key] = sf;
      this.activate(sf);
    } else if (sf.value.stamp < pulse.stamp) {
      sf.init(pulse);
      this.activate(sf);
    }

    return sf;
  },

  clean() {
    const flows = this.value;
    for (const key in flows) {
      if (flows[key].count === 0) {
        const detach = flows[key].detachSubflow;
        if (detach) detach();
        delete flows[key];
      }
    }
  },

  initTargets() {
    const a = this._targets;
    const n = a.length;
    for (let i=0; i<n && a[i] != null; ++i) {
      a[i] = null; // ensure old flows can be garbage collected
    }
    a.active = 0;
  },

  transform(_, pulse) {
    const df = pulse.dataflow;
    const key = _.key;
    const flow = _.subflow;
    const cache = this._keys;
    const rekey = _.modified('key');
    const subflow = key => this.subflow(key, flow, pulse);

    this._group = _.group || {};
    this.initTargets(); // reset list of active subflows

    pulse.visit(pulse.REM, t => {
      const id = tupleid(t);
      const k = cache.get(id);
      if (k !== undefined) {
        cache.delete(id);
        subflow(k).rem(t);
      }
    });

    pulse.visit(pulse.ADD, t => {
      const k = key(t);
      cache.set(tupleid(t), k);
      subflow(k).add(t);
    });

    if (rekey || pulse.modified(key.fields)) {
      pulse.visit(pulse.MOD, t => {
        const id = tupleid(t);
        const k0 = cache.get(id);
        const k1 = key(t);
        if (k0 === k1) {
          subflow(k1).mod(t);
        } else {
          cache.set(id, k1);
          subflow(k0).rem(t);
          subflow(k1).add(t);
        }
      });
    } else if (pulse.changed(pulse.MOD)) {
      pulse.visit(pulse.MOD, t => {
        subflow(cache.get(tupleid(t))).mod(t);
      });
    }

    if (rekey) {
      pulse.visit(pulse.REFLOW, t => {
        const id = tupleid(t);
        const k0 = cache.get(id);
        const k1 = key(t);
        if (k0 !== k1) {
          cache.set(id, k1);
          subflow(k0).rem(t);
          subflow(k1).add(t);
        }
      });
    }

    if (pulse.clean()) {
      df.runAfter(() => { this.clean(); cache.clean(); });
    } else if (cache.empty > df.cleanThreshold) {
      df.runAfter(cache.clean);
    }

    return pulse;
  }
});
