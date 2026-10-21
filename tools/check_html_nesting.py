import html.parser, sys
class P(html.parser.HTMLParser):
    def __init__(s): super().__init__(); s.stack=[]; s.bad=[]
    def handle_starttag(s,t,a):
        if t in ("meta","link","br","input","img","hr","source"): return
        d=dict(a); s.stack.append((t,d.get("id")))
        if d.get("id") and d["id"].endswith("-modal"):
            parents=[x[1] for x in s.stack[:-1] if x[1] and x[1].endswith("-modal")]
            if parents: s.bad.append((d["id"],"nested inside",parents))
    def handle_endtag(s,t):
        for i in range(len(s.stack)-1,-1,-1):
            if s.stack[i][0]==t: del s.stack[i:]; break
p=P(); p.feed(open("frontend/index.html",encoding="utf-8").read())
print("modal nesting problems:", p.bad); sys.exit(1 if p.bad else 0)
