
s/\(([0-9]+),([0-9]+)\)//

s/but it is exported as '[^']*'/but it is exported as '~'/

s/typeof import\("[^"]*"\)/typeof import("~")/g

s/\.\.\. [0-9]+ more \.\.\./... ~ more .../g
