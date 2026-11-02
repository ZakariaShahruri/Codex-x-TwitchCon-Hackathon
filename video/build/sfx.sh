#!/bin/sh
# Synthesizes every sound effect in the video with ffmpeg, so we own all of it. Output: video/renders/sfx/*.wav
set -e
out="$(dirname "$0")/../renders/sfx"
mkdir -p "$out"
gen() { ffmpeg -v error -y -f lavfi -i "$2" ${3:+-af "$3"} -ar 48000 -ac 2 "$out/$1.wav"; }

gen pop     "aevalsrc='0.35*sin(2*PI*(1100+2600*t)*t)*exp(-38*t)':d=0.14"
gen typing  "aevalsrc='0.5*(random(0)-0.5)*lt(mod(t+0.013*sin(t*37),0.083),0.011)*exp(-260*mod(t,0.083))':d=4.5" "highpass=f=1800,lowpass=f=9000"
gen click   "aevalsrc='0.6*(random(0)-0.5)*exp(-180*t)':d=0.06" "highpass=f=1500"
gen glitch  "aevalsrc='0.45*sgn(sin(2*PI*(70+40*floor(t*25))*t))*gt(random(0),0.35)':d=0.8" "bandpass=f=900:width_type=o:w=2,afade=out:st=0.6:d=0.2"
gen alarm   "aevalsrc='0.22*sgn(sin(2*PI*if(lt(mod(t,0.32),0.16),880,660)*t))':d=1.3" "lowpass=f=4000,afade=out:st=1.0:d=0.3"
gen whoosh  "anoisesrc=d=0.7:c=pink:a=0.6" "bandpass=f=900:width_type=o:w=3,afade=in:d=0.3,afade=out:st=0.3:d=0.4"
gen ding    "aevalsrc='0.28*sin(2*PI*1318*t)*exp(-5*t)+0.24*sin(2*PI*1760*(t-0.13))*exp(-5*(t-0.13))*gt(t,0.13)':d=1.1"
gen save    "aevalsrc='0.16*sgn(sin(2*PI*if(lt(t,0.06),523,if(lt(t,0.12),659,if(lt(t,0.18),784,1047)))*t))*exp(-3.2*t)':d=0.55" "lowpass=f=6000"
gen thud    "aevalsrc='0.9*sin(2*PI*55*t*(1+2*exp(-18*t)))*exp(-5*t)':d=0.8"
gen tick    "aevalsrc='0.22*sin(2*PI*2300*t)*exp(-70*t)':d=0.06"
gen blip    "aevalsrc='0.13*sgn(sin(2*PI*880*t))*exp(-18*t)':d=0.1"
gen boing   "aevalsrc='0.3*sin(2*PI*(260+900*t)*t)*exp(-7*t)':d=0.3"
gen jump    "aevalsrc='0.14*sgn(sin(2*PI*(300+1400*t)*t))*exp(-5*t)':d=0.28" "lowpass=f=5000"
gen sting   "aevalsrc='0.16*sgn(sin(2*PI*(if(lt(t,0.11),660,990))*t))*exp(-4*t)':d=0.45"
gen hum     "anoisesrc=d=28:c=brown:a=0.5" "lowpass=f=260,volume=0.5"
ls "$out" | wc -l
