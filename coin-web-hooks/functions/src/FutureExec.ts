import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { USERS } from "./Constants";
import { CoinUtils } from "./Utils";
import { CommonUtils } from "./CommonUtils";

const isDebug: boolean = false;
export class FutureExec{
    static async execute(groupCd: number, body: any) {

        const symbol = body.symbol;
        let cid = body.cid;
        const side: 'buy' | 'sell' = body.side;
        const leverage: number = parseFloat(body.leverage);
        const takeProfit: any = body.takeProfit;
        let stopLoss: any = body.stopLoss;
        const safeRatio: number = parseFloat(body.safeRatio) || 1; // 비율로 보낼것 
        let addType: 'e' | 'f' | 's' = body.addType || 'e'; // e: entry, f:first, s:second 매매타입    
        let pyramidingType: 'ex' | 'se' = body.pyramidingType || 'ex'; // ex: 기존추매(이평/거래량/볼밴/스톡케스틱), se: 이격추매 
        let addTakeProfitCount: number = CommonUtils.setAddTakeProfitCount(body.addTakeProfitCount); // 추매 발동 조건으로 익절수가 현재값을 초과하면 추매를 한다. 
        let addRate: number = CommonUtils.setAddRate(body.addRate); // 추매 비율

        // conditions가 있을때만 조건이 일치하는지 체크 
        const conditions: any[] = body.conditions;
        const isOnce = (!body.isOnce || 'false' === body.isOnce) ? false : true;
        const isTelMsgSkip = (!body.isTelMsgSkip || 'false' === body.isTelMsgSkip) ? false : true;    // 텔레그램 메세지 안보내고 매매할때 옵션
        
        // 1분봉 캔들이 10%급등락이 있는 비정상적인 상황일때 모든 포진션을 종료하고 메뉴얼모드로 변경한다.
        let isEmergency = body.isEmergency;
        if ('false' === isEmergency) isEmergency = false;
        else if ('true' === isEmergency) isEmergency = true;

        // 텔레그램 전체 메세지
        let telegramMsgsArr = new Array();

        // manaulMode가 없는 멤버는 오너(sanghoono)의 manaulMode를 넣어준다.
        let ownerManaulMode = 0;

        for (const user of USERS) {
            try {
                // groupNo과 cid가 일치하지 않으면 패스한다.
                if (user.cid !== cid || user.groupCd !== groupCd) continue;

                const telegramId = user.telegramId;

                // 유저 로깅
                functions.logger.log(`\u{1F449} start user info ${user.groupCd} ${user.nickName} - ${user.email}`);

                let isManualEntry = false;
                let isManualTakeProfit = false;
                const positionRef = admin.firestore().collection('myPositions').doc(user.email);

                let positionData = await positionRef.get();

                if ('sanghoono@gmail.com' === user.email) ownerManaulMode = positionData.data()?.manaulMode || 0;
                if (positionData.data()?.manaulMode === undefined){
                    await positionRef.update({ manaulMode: ownerManaulMode });
                    positionData = await positionRef?.get();
                }

                const cu = new CoinUtils(
                    user.nickName,
                    user.email,
                    user.binance.apiKey,
                    user.binance.secret,
                    'binance',
                    { 'defaultType': 'future' } // 기본거래 선물
                );
                const myPosition = await cu.myPosition(symbol);
                const mySide = (myPosition.positionAmt > 0) ? "buy" : "sell";

                // 바이낸스의 포지션이 없으면 초기화 #33 #32
                if (0.0 === myPosition.positionAmt && positionData.exists) {
                    await positionRef?.set({ addType: 'e', addCount: 0, positionAmt: 0 }, { merge: true });
                    positionData = await positionRef.get();
                }

                // db에 포지션 정보가 존재하면 유효성 체크 시작 
                if (positionData.exists) {
                    const tmpData = positionData.data();
                    if (tmpData) {
                        isManualEntry = tmpData.isMaualEntry || false;
                        isManualTakeProfit = tmpData.isManualTakeProfit || false;

                        // 조건이 존재하면 체크
                        if (conditions && conditions.length > 0 && conditions.filter(c => c.side === mySide).length > 0) {
                            const findCondition = conditions.filter(c => c.side === mySide).pop();
                            if (findCondition) {
                                if (findCondition.stopLoss) stopLoss = findCondition.stopLoss;
                                if (findCondition.addRate) addRate = CommonUtils.setAddRate(findCondition.addRate);
                                if (findCondition.addType) addType = findCondition.addType || 'e';
                                if (findCondition.cid) cid = findCondition.cid;
                                if (findCondition.addTakeProfitCount) addTakeProfitCount = findCondition.addTakeProfitCount;
                                functions.logger.log(`\u{2611} conditions가 존재`, findCondition);
                            }
                        }

                        // 포지션 변경 일때 side가 다른 경우만 진행이 된다. 
                        // #26 포지션이 존재하지 않으면 포지션을 진행한다.
                        if (addType === 'e' && side === tmpData.side && leverage > 0 && Math.abs(myPosition.positionAmt) > 0) {
                            functions.logger.log(`\u{1F6AB} 이전 포지션(${tmpData.side})와 현재 요청 ${side}가 동일하면 실행하지 않는다. `);
                            continue;
                        }
                        // 추매 시 사이드가 맞지 않으면 스킵
                        if (addType !== 'e' || (addType === 'e' && leverage === 0)) {
                            const mySide = (myPosition.positionAmt > 0) ? 'buy' : (myPosition.positionAmt < 0) ? 'sell' : null;
                            if (mySide && mySide !== side) {
                                functions.logger.log(`\u{1F6AB} 추매, 익절 시에 이전 포지션(${mySide})와 현재 요청 ${side}가 동일하지 않으면 실행하지 않는다. `);
                                continue;
                            }
                        }
                        // isOnce 가 true고 저장된 값도 true면 스킵한다.
                        if (isOnce === true && isOnce === tmpData.isOnce) {
                            functions.logger.log(`\u{1F6AB} isOnce가 ${isOnce} 이고 저장된 값은 ${tmpData.isOnce} 이기 때문에 skip 한다.`);
                            continue;
                        }
                    }
                }

                // 결과 값 저장 
                let result = {
                    close: false,
                    create: false,
                    takeProfit: false,
                    stopLoss: false,
                    telegram: false
                };

                let telegramMsg : string = '';

                // 텔레그램 메세지 테스트
                if (leverage === -999 && !isManualEntry) {
                    if (addType === 'e') {

                        // if ('5295328420' === telegramId){
                            // functions.logger.log('텔레그램 메세지 테스트');
                            const result = await cu.telegramMsgTest(symbol);
                            functions.logger.log('telegramMsgTest result', result);
                            // result.close = result[0]
                            // telegramMsg = result[1]

                            // telegramMsg = result;
                            // const results = await cu.stopLoss(symbol, positionRef, stopLoss.priceString,
                            //     stopLoss.pricePercent, stopLoss.pricePercents, stopLoss.priceNumber, isDebug);
                            // result.stopLoss = results[0];
                            // telegramMsg = telegramMsg + results[1];
                        // }
                        
                    }
                }
                // user Balance Info
                if (leverage === -888 && addType === 'e' && !isManualEntry) {
                    if (stopLoss &&
                        (stopLoss.priceString || stopLoss.pricePercent || Array.isArray(stopLoss.pricePercents) || stopLoss.priceNumber)) {
                        
                        functions.logger.log('수동 stopLoss 시작');
                        const results = await cu.stopLoss(symbol, positionRef, stopLoss.priceString,
                            stopLoss.pricePercent, stopLoss.pricePercents, stopLoss.priceNumber, isDebug);
                        result.stopLoss = results[0];
                        telegramMsg = telegramMsg + results[1];                        
                    }
                }

                // 청산(로스컷만 실행하려면 leverage에 -1을 넣는다.)(1분봉 ATR 매매봇 #29)
                if (leverage === -1 && !isManualEntry) {
                    if (addType === 'e') {
                        // 로스컷
                        const results = await cu.closeBinanceFuture(symbol, positionRef, isDebug);
                        result.close = results[0];
                        if (result.close) functions.logger.log(`\u{1F44C} 로스컷 완료`);
                        telegramMsg = results[1];
                    }
                }

                // 매수 / 매도 / 추매
                if (leverage > 0 && !isManualEntry) {
                    if ((addType === 'e' && positionData.data()?.manaulMode < 3) 
                        || (addType === 'f' && pyramidingType === 'ex' && positionData.data()?.manaulMode < 2) 
                        || (addType === 'f' && pyramidingType === 'se' && positionData.data()?.manaulMode < 1) ){
                        if (addType === 'e') {
                            // 이전 포지션 청산
                            const results = await cu.closeBinanceFuture(symbol, positionRef, isDebug);
                            if (result.close) functions.logger.log(`\u{1F44C} 이전 포지션 청산 완료`);
                            result.close = results[0];
                        }
                        const results = await cu.createBinanceFuture({
                            symbol, side, leverage, positionRef, safeRatio, cid, addRate, addType, pyramidingType, addTakeProfitCount, isOnce
                        }, isDebug);
                        result.create = results[0];
                        telegramMsg = results[1];
                    }
                }

                // 익절
                if (takeProfit && Array.isArray(takeProfit.amtPercents) && !isManualTakeProfit) {
                    if (positionData.data()?.manaulMode < 3){
                        const results = await cu.takeProfit({ symbol, side, leverage, positionRef, takeProfitObject: takeProfit, cid }, isDebug);
                        result.takeProfit = results[0];
                        telegramMsg = results[1];
                    }
                }

                // 스탑로스 (스탑로스값이 넘어오고, 익절이 성공한 경우 스탑로스 다시 )
                if (stopLoss &&
                    (stopLoss.priceString || stopLoss.pricePercent || Array.isArray(stopLoss.pricePercents) || stopLoss.priceNumber)) {
                    if (positionData.data()?.manaulMode < 3){
                        // 익절 파라미터 없으면 매수/매도/추매가 성공 했을때
                        // 익절 파라미터 있으면 익절이 성공 했을때 스탑로스건다.
                        if ((!takeProfit && result.create) || (takeProfit && result.takeProfit)) {
                            // functions.logger.log('stopLoss 시작');
                            const results = await cu.stopLoss(symbol, positionRef, stopLoss.priceString,
                                stopLoss.pricePercent, stopLoss.pricePercents, stopLoss.priceNumber, isDebug);
                            result.stopLoss = results[0];
                            telegramMsg = telegramMsg + results[1];
                        }
                    }
                }

                // 1분봉 캔들이 10%급등락이 있는 비정상적인 상황일때 모든 포진션을 종료하고 메뉴얼모드로 변경하고 관리자 텔레그램 알람 보낸다.
                if (isEmergency !== undefined){
                    const isManualEntry2 : boolean = isEmergency;   // Type을 강제로 Boolean으로 변경
                    await positionRef.update({ isManualEntry: isManualEntry2 });

                    // 관리자에게 텔레그램 메세지를 보낸다.
                    

                    functions.logger.log(`\u{1F44C} isEmergency`, isEmergency);
                }

                // 매매 내용 텔레그램 메세지 보내기                
                if ('' !== telegramMsg && '' !== telegramId){
                    telegramMsgsArr.push(new Array(telegramId,user.nickName,telegramMsg));
                }            
                
                functions.logger.log(`\u{1F448} ${user.nickName} - ${user.email} 처리 완료`);

            } catch (error) {
                functions.logger.error(error);
            }
        }

        // isTelMsgSkip 파라메터를 안보냈을때만 메세지를 보낸다.
        if (isTelMsgSkip  === false && telegramMsgsArr.length > 0){
             const cu2 = new CoinUtils('nickName','email','apiKey','secret','binance',{ 'defaultType': 'future' });
            for (var i=0; i<telegramMsgsArr.length; i++){
                 await cu2.sendTelegramMsg(telegramMsgsArr[i][2] + `\r\n\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}`, telegramMsgsArr[i][0]);
            }          
            
            functions.logger.log(telegramMsgsArr);
        }
        
        return ('ok');

    }

    // async execute(group: number, body : any){

    //     functions.logger.log('Future', group, body);
    // }


}